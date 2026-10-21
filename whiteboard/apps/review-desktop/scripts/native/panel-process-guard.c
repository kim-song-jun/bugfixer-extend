#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecBase.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static const char *const kPanelExecutablePath =
    "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/"
    "com.apple.appkit.xpc.openAndSavePanelService.xpc/Contents/MacOS/"
    "com.apple.appkit.xpc.openAndSavePanelService";

static bool read_process_info(pid_t pid, struct proc_bsdinfo *info) {
  const int received = proc_pidinfo(
      pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof(*info));
  return received == (int)sizeof(*info) && info->pbi_pid == (uint32_t)pid;
}

static bool read_process_path(pid_t pid, char path[PROC_PIDPATHINFO_MAXSIZE]) {
  const int received = proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE);
  if (received <= 0 || received >= PROC_PIDPATHINFO_MAXSIZE) {
    return false;
  }

  path[PROC_PIDPATHINFO_MAXSIZE - 1] = '\0';
  return path[0] == '/';
}

static void print_nullable_u64(bool present, uint64_t value) {
  if (present && value <= 9007199254740991ULL) {
    printf("%llu", (unsigned long long)value);
  } else {
    printf("null");
  }
}

static void print_nullable_status(bool present, OSStatus value) {
  if (present) {
    printf("%d", (int)value);
  } else {
    printf("null");
  }
}

static bool parse_target_pid(int argc, char *argv[], pid_t *target_pid) {
  if (argc != 2 || argv[1] == NULL || argv[1][0] == '\0') {
    return false;
  }

  errno = 0;
  char *end = NULL;
  const long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed < 1 ||
      parsed > INT_MAX) {
    return false;
  }

  *target_pid = (pid_t)parsed;
  return true;
}

static bool await_parent_release(pid_t own_pid, bool target_pid_valid,
                                 pid_t target_pid) {
  char release[8] = {0};
  printf("{\"event\":\"panel-process-guard-ready\",\"version\":1,"
         "\"ownPID\":%d,\"targetPID\":",
         (int)own_pid);
  if (target_pid_valid) {
    printf("%d", (int)target_pid);
  } else {
    printf("null");
  }
  printf("}\n");
  fflush(stdout);

  if (!target_pid_valid) {
    return false;
  }

  if (fgets(release, sizeof(release), stdin) == NULL ||
      strcmp(release, "RUN\n") != 0) {
    return false;
  }

  return fgetc(stdin) == EOF && !ferror(stdin);
}

int main(int argc, char *argv[]) {
  const pid_t own_pid = getpid();
  pid_t target_pid = 0;
  const bool target_pid_valid = parse_target_pid(argc, argv, &target_pid);
  const bool input_valid = target_pid_valid && target_pid != own_pid;
  const bool parent_released = await_parent_release(
      own_pid, input_valid, target_pid);
  struct proc_bsdinfo before = {0};
  struct proc_bsdinfo after = {0};
  bool before_info_valid = false;
  bool after_info_valid = false;
  bool before_path_valid = false;
  bool after_path_valid = false;
  bool birth_stable = false;
  bool path_matches = false;
  bool guest_status_present = false;
  bool apple_status_present = false;
  bool panel_status_present = false;
  OSStatus guest_status = 0;
  OSStatus apple_status = 0;
  OSStatus panel_status = 0;
  SecCodeRef guest_code = NULL;
  SecRequirementRef apple_requirement = NULL;
  SecRequirementRef panel_requirement = NULL;
  const char *error_code = NULL;

  if (!input_valid) {
    error_code = "invalid-target-pid";
  } else if (!parent_released) {
    error_code = "parent-handshake-invalid";
  } else {
    before_info_valid = read_process_info(target_pid, &before);
    char before_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    before_path_valid = read_process_path(target_pid, before_path);

    if (!before_info_valid || !before_path_valid) {
      error_code = "target-inspection-failed";
    } else {
      path_matches = strcmp(before_path, kPanelExecutablePath) == 0;

      int32_t target_pid_value = (int32_t)target_pid;
      CFNumberRef pid_number = CFNumberCreate(
          kCFAllocatorDefault, kCFNumberSInt32Type, &target_pid_value);
      const void *keys[] = {kSecGuestAttributePid};
      const void *values[] = {pid_number};
      CFDictionaryRef attributes = pid_number == NULL
          ? NULL
          : CFDictionaryCreate(
                kCFAllocatorDefault, keys, values, 1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks);

      if (attributes == NULL) {
        error_code = "guest-attributes-unavailable";
      } else {
        guest_status = SecCodeCopyGuestWithAttributes(
            NULL, attributes, 0, &guest_code);
        guest_status_present = true;

        if (guest_status != errSecSuccess || guest_code == NULL) {
          error_code = "guest-code-unavailable";
        } else {
          const OSStatus apple_create_status = SecRequirementCreateWithString(
              CFSTR("anchor apple"), 0, &apple_requirement);
          const OSStatus panel_create_status = SecRequirementCreateWithString(
              CFSTR("anchor apple and identifier \""
                    "com.apple.appkit.xpc.openAndSavePanelService\""),
              0, &panel_requirement);

          if (apple_create_status != errSecSuccess ||
              apple_requirement == NULL ||
              panel_create_status != errSecSuccess ||
              panel_requirement == NULL) {
            error_code = "requirement-create-failed";
          } else {
            apple_status = SecCodeCheckValidity(
                guest_code, 0, apple_requirement);
            apple_status_present = true;
            panel_status = SecCodeCheckValidity(
                guest_code, 0, panel_requirement);
            panel_status_present = true;
          }
        }
      }

      if (attributes != NULL) {
        CFRelease(attributes);
      }
      if (pid_number != NULL) {
        CFRelease(pid_number);
      }

      after_info_valid = read_process_info(target_pid, &after);
      char after_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
      after_path_valid = read_process_path(target_pid, after_path);
      const bool before_birth_valid = before.pbi_start_tvsec <= 9007199254740991ULL &&
          before.pbi_start_tvsec > 0 &&
          before.pbi_start_tvusec <= 999999ULL;
      const bool after_birth_valid = after_info_valid &&
          after.pbi_start_tvsec <= 9007199254740991ULL &&
          after.pbi_start_tvsec > 0 &&
          after.pbi_start_tvusec <= 999999ULL;
      birth_stable = before_birth_valid && after_birth_valid &&
          before.pbi_pid == after.pbi_pid &&
          before.pbi_start_tvsec == after.pbi_start_tvsec &&
          before.pbi_start_tvusec == after.pbi_start_tvusec;
      path_matches = path_matches && after_path_valid &&
          strcmp(after_path, kPanelExecutablePath) == 0;

      if (!birth_stable && error_code == NULL) {
        error_code = "target-birth-changed";
      } else if (!path_matches && error_code == NULL) {
        error_code = "target-path-mismatch";
      } else if (apple_status_present && apple_status != errSecSuccess &&
                 error_code == NULL) {
        error_code = "apple-signature-rejected";
      } else if (panel_status_present &&
                 panel_status != errSecSuccess && error_code == NULL) {
        error_code = "panel-signature-rejected";
      }
    }
  }

  const bool verified = input_valid && before_info_valid && after_info_valid &&
      birth_stable && path_matches && guest_status_present &&
      guest_status == errSecSuccess && guest_code != NULL &&
      apple_status_present && apple_status == errSecSuccess &&
      panel_status_present && panel_status == errSecSuccess &&
      apple_requirement != NULL && panel_requirement != NULL &&
      error_code == NULL;

  if (guest_code != NULL) {
    CFRelease(guest_code);
  }
  if (apple_requirement != NULL) {
    CFRelease(apple_requirement);
  }
  if (panel_requirement != NULL) {
    CFRelease(panel_requirement);
  }

  printf("{\"version\":1,\"ownPID\":%d,\"targetPID\":", (int)own_pid);
  if (target_pid_valid) {
    printf("%d", (int)target_pid);
  } else {
    printf("null");
  }
  printf(",\"birthSeconds\":");
  print_nullable_u64(before_info_valid &&
      before.pbi_start_tvsec > 0 &&
      before.pbi_start_tvsec <= 9007199254740991ULL,
      before.pbi_start_tvsec);
  printf(",\"birthMicroseconds\":");
  print_nullable_u64(before_info_valid && before.pbi_start_tvusec <= 999999ULL,
      before.pbi_start_tvusec);
  printf(",\"birthStable\":%s,\"pathMatchesSystemService\":%s",
         birth_stable ? "true" : "false",
         path_matches ? "true" : "false");
  printf(",\"appleStatus\":");
  print_nullable_status(apple_status_present, apple_status);
  printf(",\"panelRequirementStatus\":");
  print_nullable_status(panel_status_present, panel_status);
  printf(",\"verified\":%s,\"errorCode\":", verified ? "true" : "false");
  if (error_code == NULL) {
    printf("null");
  } else {
    printf("\"%s\"", error_code);
  }
  printf("}\n");
  return 0;
}
