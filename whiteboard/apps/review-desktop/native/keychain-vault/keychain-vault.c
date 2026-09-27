#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#define ACCOUNT_LENGTH 36
#define MAX_SECRET_LENGTH 16384

static void zero_bytes(void *memory, size_t length) {
  volatile unsigned char *bytes = (volatile unsigned char *)memory;
  while (length--) *bytes++ = 0;
}

static void usage(void) {
  fprintf(stderr,
    "usage: keychain-vault put slack|notion|declarative-package UUID < SECRET\n"
    "       keychain-vault get slack|notion|declarative-package UUID\n"
    "       keychain-vault delete slack|notion|declarative-package UUID\n");
}

static int is_uuid(const char *value) {
  if (!value || strlen(value) != ACCOUNT_LENGTH) return 0;
  for (size_t index = 0; index < ACCOUNT_LENGTH; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9') ||
                 (value[index] >= 'a' && value[index] <= 'f') ||
                 (value[index] >= 'A' && value[index] <= 'F'))) {
      return 0;
    }
  }
  return 1;
}

static const char *service_name(const char *provider) {
  if (strcmp(provider, "slack") == 0) return "Review Desktop OAuth: slack";
  if (strcmp(provider, "notion") == 0) return "Review Desktop OAuth: notion";
  if (strcmp(provider, "declarative-package") == 0) return "Review Desktop Declarative Connector Credential";
  return NULL;
}

static void report_security_error(const char *operation, OSStatus status) {
  CFStringRef message = SecCopyErrorMessageString(status, NULL);
  char detail[512] = "unknown Security.framework error";
  if (message) {
    if (!CFStringGetCString(message, detail, sizeof(detail), kCFStringEncodingUTF8)) {
      strlcpy(detail, "Security.framework returned a non-UTF-8 error", sizeof(detail));
    }
  }
  fprintf(stderr, "keychain-vault: %s failed (%d): %s\n", operation, (int)status, detail);
  if (message) CFRelease(message);
}

static CFStringRef create_cf_string(const char *value) {
  return CFStringCreateWithCString(kCFAllocatorDefault, value, kCFStringEncodingUTF8);
}

static CFDictionaryRef create_query(CFStringRef service, CFStringRef account, int include_data) {
  const void *keys[4] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData };
  const void *values[4] = { kSecClassGenericPassword, service, account, kCFBooleanTrue };
  return CFDictionaryCreate(kCFAllocatorDefault, keys, values, include_data ? 4 : 3,
                            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

static int read_secret(unsigned char secret[MAX_SECRET_LENGTH + 1], size_t *length) {
  size_t used = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, secret + used, MAX_SECRET_LENGTH + 1 - used);
    if (count < 0) {
      if (errno == EINTR) continue;
      fprintf(stderr, "keychain-vault: could not read secret from stdin\n");
      return 1;
    }
    if (count == 0) break;
    used += (size_t)count;
    if (used > MAX_SECRET_LENGTH) {
      fprintf(stderr, "keychain-vault: secret exceeds the 16 KiB limit\n");
      return 2;
    }
  }
  if (used == 0) {
    fprintf(stderr, "keychain-vault: secret must not be empty\n");
    return 2;
  }
  for (size_t index = 0; index < used; index++) {
    if (secret[index] < 0x21 || secret[index] > 0x7e) {
      fprintf(stderr, "keychain-vault: secret must contain printable non-space ASCII only\n");
      return 2;
    }
  }
  *length = used;
  return 0;
}

static int write_all(int fd, const UInt8 *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      fprintf(stderr, "keychain-vault: could not write secret to stdout\n");
      return 1;
    }
    offset += (size_t)count;
  }
  return 0;
}

static int put_secret(CFDictionaryRef query, const unsigned char *secret, size_t length) {
  CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, (CFIndex)length);
  if (!data) {
    fprintf(stderr, "keychain-vault: could not allocate secret data\n");
    return 1;
  }
  CFDataAppendBytes(data, secret, (CFIndex)length);
  const void *keys[2] = { kSecValueData, kSecAttrAccessible };
  const void *values[2] = { data, kSecAttrAccessibleWhenUnlockedThisDeviceOnly };
  CFDictionaryRef attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (!attributes) {
    CFIndex data_length = CFDataGetLength(data);
    UInt8 *bytes = CFDataGetMutableBytePtr(data);
    if (bytes && data_length > 0) zero_bytes(bytes, (size_t)data_length);
    CFRelease(data);
    fprintf(stderr, "keychain-vault: could not allocate Keychain attributes\n");
    return 1;
  }

  OSStatus status = SecItemUpdate(query, attributes);
  if (status == errSecItemNotFound) {
    CFMutableDictionaryRef add_attributes = CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, query);
    if (add_attributes) {
      CFDictionarySetValue(add_attributes, kSecValueData, data);
      CFDictionarySetValue(add_attributes, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
      status = SecItemAdd(add_attributes, NULL);
      CFRelease(add_attributes);
    } else {
      status = errSecAllocate;
    }
  }

  CFIndex data_length = CFDataGetLength(data);
  UInt8 *bytes = CFDataGetMutableBytePtr(data);
  if (bytes && data_length > 0) zero_bytes(bytes, (size_t)data_length);
  CFRelease(attributes);
  CFRelease(data);
  if (status != errSecSuccess) {
    report_security_error("store", status);
    return 1;
  }
  return 0;
}

static int get_secret(CFDictionaryRef query) {
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  if (status == errSecItemNotFound) {
    fprintf(stderr, "keychain-vault: credential was not found\n");
    return 3;
  }
  if (status != errSecSuccess) {
    report_security_error("read", status);
    return 1;
  }
  if (!result || CFGetTypeID(result) != CFDataGetTypeID()) {
    if (result) CFRelease(result);
    fprintf(stderr, "keychain-vault: Keychain returned an invalid credential item\n");
    return 1;
  }

  CFDataRef stored_data = (CFDataRef)result;
  CFMutableDataRef zeroable_copy = CFDataCreateMutableCopy(kCFAllocatorDefault, 0, stored_data);
  int write_result = zeroable_copy ? write_all(STDOUT_FILENO, CFDataGetBytePtr(zeroable_copy),
    (size_t)CFDataGetLength(zeroable_copy)) : 1;
  if (!zeroable_copy) fprintf(stderr, "keychain-vault: could not allocate output buffer\n");
  if (zeroable_copy) {
    CFIndex length = CFDataGetLength(zeroable_copy);
    UInt8 *bytes = CFDataGetMutableBytePtr(zeroable_copy);
    if (bytes && length > 0) zero_bytes(bytes, (size_t)length);
    CFRelease(zeroable_copy);
  }
  CFRelease(stored_data);
  return write_result;
}

static int delete_secret(CFDictionaryRef query) {
  OSStatus status = SecItemDelete(query);
  if (status == errSecItemNotFound) {
    fprintf(stderr, "keychain-vault: credential was not found\n");
    return 3;
  }
  if (status != errSecSuccess) {
    report_security_error("delete", status);
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) { usage(); return 2; }
  const char *operation = argv[1];
  const char *service = service_name(argv[2]);
  if (!service || !is_uuid(argc == 4 ? argv[3] : NULL)) {
    fprintf(stderr, "keychain-vault: service must be slack, notion, or declarative-package and account must be a canonical UUID\n");
    return 2;
  }
  if ((strcmp(operation, "put") == 0 && argc != 4) ||
      ((strcmp(operation, "get") == 0 || strcmp(operation, "delete") == 0) && argc != 4) ||
      (strcmp(operation, "put") != 0 && strcmp(operation, "get") != 0 && strcmp(operation, "delete") != 0)) {
    usage(); return 2;
  }

  CFStringRef service_string = create_cf_string(service);
  CFStringRef account_string = create_cf_string(argv[3]);
  if (!service_string || !account_string) {
    if (account_string) CFRelease(account_string);
    fprintf(stderr, "keychain-vault: could not encode Keychain item identity\n");
    return 1;
  }
  CFDictionaryRef query = create_query(service_string, account_string, strcmp(operation, "get") == 0);
  CFRelease(service_string);
  CFRelease(account_string);
  if (!query) {
    fprintf(stderr, "keychain-vault: could not allocate Keychain query\n");
    return 1;
  }

  int result;
  if (strcmp(operation, "put") == 0) {
    unsigned char secret[MAX_SECRET_LENGTH + 1];
    size_t secret_length = 0;
    int read_result = read_secret(secret, &secret_length);
    result = read_result == 0 ? put_secret(query, secret, secret_length) : read_result;
    zero_bytes(secret, sizeof(secret));
  } else if (strcmp(operation, "get") == 0) {
    result = get_secret(query);
  } else {
    result = delete_secret(query);
  }

  CFRelease(query);
  return result;
}
