#define _DARWIN_C_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <ctype.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <dirent.h>
#include <CommonCrypto/CommonDigest.h>

extern char **environ;

static void usage(void) {
  fprintf(stderr,
    "usage: bound-checkout --root CANONICAL_ROOT --dev DEV --ino INO read RELATIVE_PATH\n"
    "       bound-checkout --root CANONICAL_ROOT --dev DEV --ino INO inventory\n"
    "       bound-checkout --root CANONICAL_ROOT --dev DEV --ino INO exec git|jj [ARG ...]\n"
    "       bound-checkout --root CANONICAL_ROOT --dev DEV --ino INO provider claude ABSOLUTE_CLAUDE_PATH [ARG ...]\n"
    "       bound-checkout --root CANONICAL_ROOT --dev DEV --ino INO provider codex-node ABSOLUTE_NODE ABSOLUTE_CODEX_JS [ARG ...]\n");
}

static int fail(const char *message) {
  fprintf(stderr, "bound-checkout: %s: %s\n", message, strerror(errno));
  return 1;
}

#ifdef REVIEW_BOUND_CHECKOUT_TESTING
static int test_barrier(void) {
  const char *ready = getenv("REVIEW_BOUND_CHECKOUT_BARRIER_READY");
  const char *release = getenv("REVIEW_BOUND_CHECKOUT_BARRIER_RELEASE");
  if (!ready && !release) return 0;
  if (!ready || !release) {
    fprintf(stderr, "bound-checkout: both test barrier paths are required\n");
    return -1;
  }
  int fd = open(ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return fail("create test barrier");
  close(fd);
  while (access(release, F_OK) != 0) {
    if (errno != ENOENT) return fail("wait for test barrier");
    usleep(1000);
  }
  return 0;
}
#else
static int test_barrier(void) { return 0; }
#endif

static int parse_identity(const char *text, uintmax_t *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno || !text[0] || !end || *end) return -1;
  *value = (uintmax_t)parsed;
  return 0;
}

static int valid_relative_path(const char *path) {
  if (!path || !path[0] || path[0] == '/') return 0;
  const char *part = path;
  for (const char *cursor = path;; cursor++) {
    if (*cursor == '/' || *cursor == '\0') {
      size_t length = (size_t)(cursor - part);
      if (length == 0 || (length == 1 && part[0] == '.') ||
          (length == 2 && part[0] == '.' && part[1] == '.')) return 0;
      if (*cursor == '\0') break;
      part = cursor + 1;
    }
  }
  return 1;
}

static int read_relative_file(int root_fd, const char *path) {
  if (!valid_relative_path(path)) {
    fprintf(stderr, "bound-checkout: unsafe relative path\n");
    return 1;
  }
  if (test_barrier() != 0) return 1;
  char *copy = strdup(path);
  if (!copy) return fail("allocate path");
  int directory_fd = dup(root_fd);
  if (directory_fd < 0) { free(copy); return fail("duplicate root descriptor"); }
  char *part = copy;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = '\0';
    int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
    if (slash) flags |= O_DIRECTORY;
    int next_fd = openat(directory_fd, part, flags);
    if (next_fd < 0) {
      int saved = errno; close(directory_fd); free(copy); errno = saved;
      return fail("open relative path");
    }
    close(directory_fd);
    directory_fd = next_fd;
    if (!slash) break;
    part = slash + 1;
  }
  free(copy);
  struct stat file_stat;
  if (fstat(directory_fd, &file_stat) != 0) { close(directory_fd); return fail("stat file"); }
  if (!S_ISREG(file_stat.st_mode)) {
    close(directory_fd);
    fprintf(stderr, "bound-checkout: path is not a regular file\n");
    return 1;
  }
  char buffer[16384];
  int result = 0;
  for (;;) {
    ssize_t count = read(directory_fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) { if (errno == EINTR) continue; result = fail("read file"); break; }
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(STDOUT_FILENO, buffer + offset, (size_t)(count - offset));
      if (written < 0) { if (errno == EINTR) continue; result = fail("write stdout"); break; }
      offset += written;
    }
    if (result) break;
  }
  close(directory_fd);
  return result;
}

/* Descriptor-relative inventory; symlink targets are recorded without following them. */
static size_t inventory_entries;
static uintmax_t inventory_bytes;
static int inventory_first = 1;
static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 0x20) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static int inventory_directory(int directory_fd, const char *prefix, unsigned depth) {
  if (depth > 128) { errno = ELOOP; return fail("inventory nesting limit"); }
  int scan_fd = dup(directory_fd);
  if (scan_fd < 0) return fail("duplicate inventory directory");
  DIR *directory = fdopendir(scan_fd);
  if (!directory) { close(scan_fd); return fail("open inventory directory stream"); }
  struct dirent *entry;
  int result = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++inventory_entries > 50000) { errno = E2BIG; result = fail("inventory entry limit"); break; }
    char relative[PATH_MAX];
    int length = snprintf(relative, sizeof(relative), "%s%s%s", prefix, *prefix ? "/" : "", entry->d_name);
    if (length < 0 || (size_t)length >= sizeof(relative)) { errno = ENAMETOOLONG; result = fail("inventory path limit"); break; }
    struct stat st;
    if (fstatat(dirfd(directory), entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) { result = fail("inspect inventory entry"); break; }
    if (!inventory_first) putchar(',');
    inventory_first = 0;
    printf("{\"path\":"); json_string(relative);
    if (S_ISLNK(st.st_mode)) {
      char target[PATH_MAX]; ssize_t count = readlinkat(dirfd(directory), entry->d_name, target, sizeof(target) - 1);
      if (count < 0) { result = fail("read inventory symlink"); break; }
      target[count] = '\0'; printf(",\"kind\":\"symlink\",\"target\":"); json_string(target); putchar('}');
    } else if (S_ISDIR(st.st_mode)) {
      puts(",\"kind\":\"directory\"}");
      int child = openat(dirfd(directory), entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { result = fail("open inventory directory"); break; }
      struct stat opened;
      if (fstat(child, &opened) != 0 || opened.st_dev != st.st_dev || opened.st_ino != st.st_ino) { close(child); errno = ESTALE; result = fail("inventory directory changed"); break; }
      result = inventory_directory(child, relative, depth + 1); close(child); if (result) break;
    } else if (S_ISREG(st.st_mode)) {
      if (st.st_size < 0 || (uintmax_t)st.st_size > 128U * 1024U * 1024U || inventory_bytes + (uintmax_t)st.st_size > 2U * 1024U * 1024U * 1024U) { errno = EFBIG; result = fail("inventory file size limit"); break; }
      int file = openat(dirfd(directory), entry->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      if (file < 0) { result = fail("open inventory file"); break; }
      struct stat opened; CC_SHA256_CTX hash; CC_SHA256_Init(&hash); unsigned char buffer[32768]; ssize_t count;
      if (fstat(file, &opened) != 0 || !S_ISREG(opened.st_mode) || opened.st_dev != st.st_dev || opened.st_ino != st.st_ino) { close(file); errno = ESTALE; result = fail("inventory file changed"); break; }
      uintmax_t size = 0;
      while ((count = read(file, buffer, sizeof(buffer))) != 0) {
        if (count < 0) { if (errno == EINTR) continue; result = fail("read inventory file"); break; }
        size += (uintmax_t)count; if (size > 128U * 1024U * 1024U || inventory_bytes + size > 2U * 1024U * 1024U * 1024U) { errno = EFBIG; result = fail("inventory byte limit"); break; }
        CC_SHA256_Update(&hash, buffer, (CC_LONG)count);
      }
      struct stat finished;
      if (!result && (fstat(file, &finished) != 0 || size != (uintmax_t)opened.st_size || finished.st_dev != opened.st_dev || finished.st_ino != opened.st_ino || finished.st_size != opened.st_size || finished.st_mtimespec.tv_sec != opened.st_mtimespec.tv_sec || finished.st_mtimespec.tv_nsec != opened.st_mtimespec.tv_nsec || finished.st_ctimespec.tv_sec != opened.st_ctimespec.tv_sec || finished.st_ctimespec.tv_nsec != opened.st_ctimespec.tv_nsec)) { errno = ESTALE; result = fail("inventory file changed while hashing"); }
      if (close(file) != 0 && !result) result = fail("close inventory file");
      if (result) break;
      unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(digest, &hash); char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
      for (size_t i = 0; i < sizeof(digest); i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
      inventory_bytes += size;
      printf(",\"kind\":\"file\",\"size\":%" PRIuMAX ",\"sha256\":\"%s\"}", size, hex);
    } else { puts(",\"kind\":\"special\"}"); }
  }
  closedir(directory);
  return result;
}
static int inventory_root(int root_fd) {
  fputs("{\"entries\":[", stdout);
  int result = inventory_directory(root_fd, "", 0);
  if (result) return result;
  printf("],\"entryCount\":%zu,\"fileBytes\":%" PRIuMAX "}\n", inventory_entries, inventory_bytes);
  return 0;
}

static const char *trusted_executable(const char *name) {
  if (strcmp(name, "git") == 0) return "/usr/bin/git";
  if (strcmp(name, "jj") == 0) {
    static const char *candidates[] = {"/opt/homebrew/bin/jj", "/usr/local/bin/jj", "/usr/bin/jj"};
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++)
      if (access(candidates[i], X_OK) == 0) return candidates[i];
  }
  return NULL;
}

static int reject_repository_path_options(const char *tool, char **arguments) {
  if (strcmp(tool, "git") == 0) {
    for (size_t index = 1; arguments[index]; index++) {
      const char *argument = arguments[index];
      if (strcmp(argument, "-C") == 0 || strncmp(argument, "-C", 2) == 0 ||
          strcmp(argument, "--git-dir") == 0 || strncmp(argument, "--git-dir=", 10) == 0 ||
          strcmp(argument, "--work-tree") == 0 || strncmp(argument, "--work-tree=", 12) == 0 ||
          strcmp(argument, "--super-prefix") == 0 || strncmp(argument, "--super-prefix=", 15) == 0 ||
          strcmp(argument, "--exec-path") == 0 || strncmp(argument, "--exec-path=", 12) == 0 ||
          strcmp(argument, "-c") == 0 || strncmp(argument, "-c", 2) == 0 ||
          strcmp(argument, "--config-env") == 0 || strncmp(argument, "--config-env=", 13) == 0) {
        fprintf(stderr, "bound-checkout: git repository/path override options are not allowed\n");
        return 1;
      }
      if (argument[0] != '-') break;
    }
  } else if (strcmp(tool, "jj") == 0) {
    for (size_t index = 1; arguments[index]; index++) {
      const char *argument = arguments[index];
      if (strcmp(argument, "-R") == 0 || strncmp(argument, "-R", 2) == 0 ||
          strcmp(argument, "--repository") == 0 || strncmp(argument, "--repository=", 13) == 0 ||
          strcmp(argument, "--repo") == 0 || strncmp(argument, "--repo=", 7) == 0) {
        fprintf(stderr, "bound-checkout: jj repository override options are not allowed\n");
        return 1;
      }
      if (argument[0] != '-') break;
    }
  }
  return 0;
}

static void strip_repository_override_environment(void) {
  size_t read_index = 0, write_index = 0;
  while (environ[read_index]) {
    const char *entry = environ[read_index++];
    if (strncmp(entry, "GIT_", 4) == 0 || strncmp(entry, "JJ_", 3) == 0) continue;
    environ[write_index++] = (char *)entry;
  }
  environ[write_index] = NULL;
}

static int canonical_path_for_descriptor(int fd, char *path, size_t capacity) {
  if (capacity < PATH_MAX || fcntl(fd, F_GETPATH, path) != 0) return -1;
  path[capacity - 1] = '\0';
  char canonical[PATH_MAX];
  struct stat descriptor_stat, path_stat;
  if (!realpath(path, canonical) || strcmp(path, canonical) != 0 ||
      fstat(fd, &descriptor_stat) != 0 || stat(path, &path_stat) != 0 ||
      descriptor_stat.st_dev != path_stat.st_dev || descriptor_stat.st_ino != path_stat.st_ino)
    return -1;
  return 0;
}

static int trimmed_equals(const char *start, size_t length, const char *expected) {
  while (length && isspace((unsigned char)*start)) { start++; length--; }
  while (length && isspace((unsigned char)start[length - 1])) length--;
  return strlen(expected) == length && strncasecmp(start, expected, length) == 0;
}

static int config_has_external_metadata(int git_fd) {
  int config_fd = openat(git_fd, "config", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (config_fd < 0) {
    if (errno == ENOENT) return 0;
    return 1;
  }
  struct stat config_stat;
  if (fstat(config_fd, &config_stat) != 0 || !S_ISREG(config_stat.st_mode) || config_stat.st_size > 1024 * 1024) {
    close(config_fd);
    return 1;
  }
  size_t length = (size_t)config_stat.st_size;
  char *contents = malloc(length + 1);
  if (!contents) { close(config_fd); return 1; }
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(config_fd, contents + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { free(contents); close(config_fd); return 1; }
    offset += (size_t)count;
  }
  close(config_fd);
  contents[length] = '\0';

  int in_core = 0;
  int external = 0;
  char *line = contents;
  while (line < contents + length) {
    char *line_end = memchr(line, '\n', (size_t)(contents + length - line));
    char *next_line = line_end ? line_end + 1 : contents + length;
    char *end = line_end ? line_end : contents + length;
    char *comment = memchr(line, '#', (size_t)(end - line));
    char *semicolon = memchr(line, ';', (size_t)(end - line));
    if (comment && (!semicolon || comment < semicolon)) end = comment;
    else if (semicolon) end = semicolon;
    while (line < end && isspace((unsigned char)*line)) line++;
    while (end > line && isspace((unsigned char)end[-1])) end--;
    if (line < end && *line == '[' && end[-1] == ']') {
      char *section = line + 1;
      char *section_end = end - 1;
      while (section < section_end && isspace((unsigned char)*section)) section++;
      char *name_end = section;
      while (name_end < section_end && !isspace((unsigned char)*name_end) && *name_end != '"') name_end++;
      in_core = trimmed_equals(section, (size_t)(name_end - section), "core");
      if (trimmed_equals(section, (size_t)(name_end - section), "include") ||
          (name_end - section >= 7 && strncasecmp(section, "include", 7) == 0)) external = 1;
    } else if (line < end && *line != '#' && *line != ';') {
      char *key_end = line;
      while (key_end < end && !isspace((unsigned char)*key_end) && *key_end != '=') key_end++;
      if (in_core && trimmed_equals(line, (size_t)(key_end - line), "worktree")) external = 1;
    }
    if (external) break;
    line = next_line;
  }
  free(contents);
  return external;
}

static int open_local_git_directory(int root_fd) {
  int git_fd = openat(root_fd, ".git", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (git_fd < 0) {
    fprintf(stderr, "bound-checkout: Git execution requires a local .git directory; linked worktrees and external metadata are unavailable\n");
    return -1;
  }
  struct stat metadata_stat;
  if (fstat(git_fd, &metadata_stat) != 0 || !S_ISDIR(metadata_stat.st_mode)) {
    close(git_fd);
    fprintf(stderr, "bound-checkout: local Git metadata is unavailable\n");
    return -1;
  }
  if (config_has_external_metadata(git_fd)) {
    close(git_fd);
    fprintf(stderr, "bound-checkout: external Git config metadata is unavailable\n");
    return -1;
  }
  if (fstatat(git_fd, "config.worktree", &metadata_stat, AT_SYMLINK_NOFOLLOW) == 0) {
    close(git_fd);
    fprintf(stderr, "bound-checkout: linked worktree configuration is unavailable\n");
    return -1;
  }
  if (errno != ENOENT) {
    close(git_fd);
    return fail("inspect linked worktree configuration");
  }
  struct stat entry_stat;
  if (fstatat(git_fd, "commondir", &entry_stat, AT_SYMLINK_NOFOLLOW) == 0) {
    close(git_fd);
    fprintf(stderr, "bound-checkout: linked worktree Git metadata is unavailable\n");
    return -1;
  }
  if (errno != ENOENT) {
    close(git_fd);
    fail("inspect Git metadata");
    return -1;
  }
  int objects_fd = openat(git_fd, "objects", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (objects_fd >= 0) {
    int info_fd = openat(objects_fd, "info", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(objects_fd);
    if (info_fd >= 0) {
      if (fstatat(info_fd, "alternates", &entry_stat, AT_SYMLINK_NOFOLLOW) == 0) {
        close(info_fd);
        close(git_fd);
        fprintf(stderr, "bound-checkout: external Git object metadata is unavailable\n");
        return -1;
      }
      if (errno != ENOENT) {
        close(info_fd);
        close(git_fd);
        fail("inspect Git object metadata");
        return -1;
      }
      close(info_fd);
    } else if (errno != ENOENT) {
      close(git_fd);
      fprintf(stderr, "bound-checkout: unsafe Git object metadata path\n");
      return -1;
    }
  } else if (errno != ENOENT) {
    close(git_fd);
    fprintf(stderr, "bound-checkout: unsafe Git object metadata path\n");
    return -1;
  }
  return git_fd;
}

static int require_local_jj_directory(int root_fd) {
  int jj_fd = openat(root_fd, ".jj", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (jj_fd < 0) {
    fprintf(stderr, "bound-checkout: jj execution requires a local .jj directory\n");
    return 1;
  }
  close(jj_fd);
  return 0;
}

static int shell_wrapper_fd(int fd) {
  char first_line[512];
  ssize_t count = pread(fd, first_line, sizeof(first_line) - 1, 0);
  if (count < 2 || first_line[0] != '#' || first_line[1] != '!') return 0;
  first_line[count] = '\0';
  char *newline = strchr(first_line, '\n');
  if (newline) *newline = '\0';
  char *interpreter = first_line + 2;
  while (*interpreter == ' ' || *interpreter == '\t') interpreter++;
  char *end = interpreter;
  while (*end && *end != ' ' && *end != '\t' && *end != '\r') end++;
  char saved = *end;
  *end = '\0';
  const char *basename = strrchr(interpreter, '/');
  basename = basename ? basename + 1 : interpreter;
  int rejected = strcmp(basename, "sh") == 0 || strcmp(basename, "bash") == 0 ||
                 strcmp(basename, "zsh") == 0 || strcmp(basename, "dash") == 0 ||
                 strcmp(basename, "ksh") == 0;
  *end = saved;
  if (strcmp(basename, "env") == 0) {
    char *argument = end;
    while (*argument == ' ' || *argument == '\t') argument++;
    if (strncmp(argument, "-S", 2) == 0 && (argument[2] == ' ' || argument[2] == '\t')) {
      argument += 2;
      while (*argument == ' ' || *argument == '\t') argument++;
    }
    char *argument_end = argument;
    while (*argument_end && *argument_end != ' ' && *argument_end != '\t' && *argument_end != '\r') argument_end++;
    char argument_saved = *argument_end;
    *argument_end = '\0';
    const char *argument_basename = strrchr(argument, '/');
    argument_basename = argument_basename ? argument_basename + 1 : argument;
    rejected = rejected || strcmp(argument_basename, "sh") == 0 ||
               strcmp(argument_basename, "bash") == 0 || strcmp(argument_basename, "zsh") == 0 ||
               strcmp(argument_basename, "dash") == 0 || strcmp(argument_basename, "ksh") == 0;
    *argument_end = argument_saved;
  }
  return rejected;
}

static int is_shebang_script(int fd) {
  char first_line[512];
  ssize_t count = pread(fd, first_line, sizeof(first_line) - 1, 0);
  return count >= 2 && first_line[0] == '#' && first_line[1] == '!';
}

static int node_shebang_script(int fd) {
  char first_line[512];
  ssize_t count = pread(fd, first_line, sizeof(first_line) - 1, 0);
  if (count < 2 || first_line[0] != '#' || first_line[1] != '!') return 0;
  first_line[count] = '\0';
  char *interpreter = first_line + 2;
  while (*interpreter == ' ' || *interpreter == '\t') interpreter++;
  char *end = interpreter;
  while (*end && *end != ' ' && *end != '\t' && *end != '\r' && *end != '\n') end++;
  char saved = *end;
  *end = '\0';
  const char *basename = strrchr(interpreter, '/');
  basename = basename ? basename + 1 : interpreter;
  if (strcmp(basename, "env") == 0) {
    *end = saved;
    interpreter = end;
    while (*interpreter == ' ' || *interpreter == '\t') interpreter++;
    end = interpreter;
    while (*end && *end != ' ' && *end != '\t' && *end != '\r' && *end != '\n') end++;
    saved = *end;
    *end = '\0';
    basename = strrchr(interpreter, '/');
    basename = basename ? basename + 1 : interpreter;
  }
  int is_node = strcmp(basename, "node") == 0 || strcmp(basename, "nodejs") == 0;
  *end = saved;
  return is_node;
}

static int open_provider_file(const char *path, const char *expected_input_basename,
                              const char *expected_target_basename, int require_executable,
                              char canonical[PATH_MAX]) {
  if (!path || path[0] != '/') {
    fprintf(stderr, "bound-checkout: provider paths must be absolute\n");
    return -1;
  }
  const char *input_basename = strrchr(path, '/');
  input_basename = input_basename ? input_basename + 1 : path;
  if (strcmp(input_basename, expected_input_basename) != 0) {
    fprintf(stderr, "bound-checkout: provider path basename does not match the selected executable\n");
    return -1;
  }
  if (!realpath(path, canonical)) {
    fprintf(stderr, "bound-checkout: provider path is unavailable: %s\n", strerror(errno));
    return -1;
  }
  const char *target_basename = strrchr(canonical, '/');
  target_basename = target_basename ? target_basename + 1 : canonical;
  if (expected_target_basename && strcmp(target_basename, expected_target_basename) != 0) {
    fprintf(stderr, "bound-checkout: resolved provider path does not match its expected target\n");
    return -1;
  }
  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
  int fd = open(canonical, flags);
  if (fd < 0) {
    fprintf(stderr, "bound-checkout: provider file is unavailable: %s\n", strerror(errno));
    return -1;
  }
  struct stat file_stat;
  if (fstat(fd, &file_stat) != 0 || !S_ISREG(file_stat.st_mode) ||
      (require_executable && faccessat(AT_FDCWD, canonical, X_OK, 0) != 0)) {
    close(fd);
    fprintf(stderr, "bound-checkout: provider file must be a regular%s file\n",
            require_executable ? " executable" : "");
    return -1;
  }
  return fd;
}

static int preserve_descriptor(int fd, const char *label) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC) < 0) return fail(label);
  return 0;
}

static int execute_provider(int root_fd, const char *provider, char **arguments) {
  const char *provider_path = arguments[0];
  char canonical[PATH_MAX];
  int executable_fd = open_provider_file(provider_path, provider, NULL, 1, canonical);
  if (executable_fd < 0) return 1;
  if (is_shebang_script(executable_fd)) {
    int shell_wrapper = shell_wrapper_fd(executable_fd);
    close(executable_fd);
    fprintf(stderr, shell_wrapper ?
      "bound-checkout: shell wrapper executables are not allowed\n" :
      "bound-checkout: script providers must use the codex-node mode\n");
    return 1;
  }
  if (test_barrier() != 0) { close(executable_fd); return 1; }
  if (fchdir(root_fd) != 0) { close(executable_fd); return fail("change to bound root"); }
  char current_path[PATH_MAX];
  if (canonical_path_for_descriptor(executable_fd, current_path, sizeof(current_path)) != 0 ||
      strcmp(current_path, canonical) != 0) {
    close(executable_fd);
    fprintf(stderr, "bound-checkout: provider executable path changed before launch\n");
    return 1;
  }
  if (preserve_descriptor(root_fd, "preserve bound root descriptor") != 0 ||
      preserve_descriptor(executable_fd, "preserve provider executable descriptor") != 0) {
    close(executable_fd);
    return 1;
  }
  execve(canonical, arguments, environ);
  return fail("execute provider");
}

static int execute_codex_node(int root_fd, char **arguments) {
  char node_path[PATH_MAX], script_path[PATH_MAX];
  const char *node_basename = strrchr(arguments[0], '/');
  node_basename = node_basename ? node_basename + 1 : arguments[0];
  if (strcmp(node_basename, "node") != 0 && strcmp(node_basename, "nodejs") != 0) {
    fprintf(stderr, "bound-checkout: Codex runtime executable must be named node or nodejs\n");
    return 1;
  }
  int node_fd = open_provider_file(arguments[0], node_basename, node_basename, 1, node_path);
  if (node_fd < 0) return 1;
  if (is_shebang_script(node_fd)) {
    int shell_wrapper = shell_wrapper_fd(node_fd);
    close(node_fd);
    fprintf(stderr, shell_wrapper ?
      "bound-checkout: shell wrapper Node runtimes are not allowed\n" :
      "bound-checkout: Node runtime must be a native executable\n");
    return 1;
  }
  int script_fd = open_provider_file(arguments[1], "codex.js", "codex.js", 1, script_path);
  if (script_fd < 0) { close(node_fd); return 1; }
  if (!node_shebang_script(script_fd)) {
    close(node_fd); close(script_fd);
    fprintf(stderr, "bound-checkout: Codex entrypoint must have a Node shebang\n");
    return 1;
  }
  if (test_barrier() != 0) { close(node_fd); close(script_fd); return 1; }
  if (fchdir(root_fd) != 0) { close(node_fd); close(script_fd); return fail("change to bound root"); }
  char current_node_path[PATH_MAX], current_script_path[PATH_MAX];
  if (canonical_path_for_descriptor(node_fd, current_node_path, sizeof(current_node_path)) != 0 ||
      strcmp(current_node_path, node_path) != 0 ||
      canonical_path_for_descriptor(script_fd, current_script_path, sizeof(current_script_path)) != 0 ||
      strcmp(current_script_path, script_path) != 0) {
    close(node_fd); close(script_fd);
    fprintf(stderr, "bound-checkout: Codex runtime or script path changed before launch\n");
    return 1;
  }
  if (preserve_descriptor(root_fd, "preserve bound root descriptor") != 0 ||
      preserve_descriptor(node_fd, "preserve Node runtime descriptor") != 0 ||
      preserve_descriptor(script_fd, "preserve Codex script descriptor") != 0) {
    close(node_fd); close(script_fd);
    return 1;
  }
  arguments[0] = node_path;
  arguments[1] = script_path;
  execve(node_path, arguments, environ);
  return fail("execute Codex Node runtime");
}

static int execute_tool(int root_fd, const char *tool, char **arguments) {
  if (reject_repository_path_options(tool, arguments) != 0) return 1;
  int git_fd = -1;
  if (strcmp(tool, "git") == 0) {
    git_fd = open_local_git_directory(root_fd);
    if (git_fd < 0) return 1;
  }
  if (strcmp(tool, "jj") == 0 && require_local_jj_directory(root_fd) != 0) return 1;
  const char *executable = trusted_executable(tool);
  if (!executable) {
    fprintf(stderr, "bound-checkout: tool is not in the trusted allowlist or is unavailable\n");
    return 1;
  }
  if (test_barrier() != 0) { if (git_fd >= 0) close(git_fd); return 1; }
  strip_repository_override_environment();
  if (fchdir(root_fd) != 0) { if (git_fd >= 0) close(git_fd); return fail("change to bound root"); }
  int descriptor_flags = fcntl(root_fd, F_GETFD);
  if (descriptor_flags < 0 || fcntl(root_fd, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0) {
    if (git_fd >= 0) close(git_fd);
    return fail("preserve bound root descriptor");
  }
  if (git_fd >= 0) {
    descriptor_flags = fcntl(git_fd, F_GETFD);
    if (descriptor_flags < 0 || fcntl(git_fd, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0) {
      close(git_fd);
      return fail("preserve bound Git metadata descriptor");
    }
    char root_path[PATH_MAX], git_path[PATH_MAX];
    if (canonical_path_for_descriptor(root_fd, root_path, sizeof(root_path)) != 0 ||
        canonical_path_for_descriptor(git_fd, git_path, sizeof(git_path)) != 0) {
      close(git_fd);
      fprintf(stderr, "bound-checkout: could not resolve the validated Git descriptors\n");
      return 1;
    }
    if (setenv("GIT_DIR", git_path, 1) != 0 || setenv("GIT_WORK_TREE", root_path, 1) != 0) {
      close(git_fd);
      return fail("bind Git to validated descriptors");
    }
  }
  arguments[0] = (char *)tool;
  execve(executable, arguments, environ);
  return fail("execute trusted tool");
}

int main(int argc, char **argv) {
  const char *root = NULL, *dev_text = NULL, *ino_text = NULL;
  int index = 1;
  while (index < argc && strncmp(argv[index], "--", 2) == 0) {
    if (index + 1 >= argc) { usage(); return 2; }
    if (strcmp(argv[index], "--root") == 0) root = argv[index + 1];
    else if (strcmp(argv[index], "--dev") == 0) dev_text = argv[index + 1];
    else if (strcmp(argv[index], "--ino") == 0) ino_text = argv[index + 1];
    else { usage(); return 2; }
    index += 2;
  }
  uintmax_t expected_dev, expected_ino;
  if (!root || !dev_text || !ino_text || index >= argc ||
      parse_identity(dev_text, &expected_dev) || parse_identity(ino_text, &expected_ino)) {
    usage(); return 2;
  }
  char canonical[PATH_MAX];
  if (!realpath(root, canonical)) return fail("resolve root");
  if (strcmp(root, canonical) != 0) {
    fprintf(stderr, "bound-checkout: root path must be canonical\n");
    return 1;
  }
  int root_fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) return fail("open root");
  struct stat root_stat;
  if (fstat(root_fd, &root_stat) != 0) { close(root_fd); return fail("stat root"); }
  if ((uintmax_t)root_stat.st_dev != expected_dev || (uintmax_t)root_stat.st_ino != expected_ino) {
    close(root_fd);
    fprintf(stderr, "bound-checkout: root identity mismatch\n");
    return 1;
  }
  int result;
  if (strcmp(argv[index], "read") == 0 && index + 2 == argc) {
    result = read_relative_file(root_fd, argv[index + 1]);
  } else if (strcmp(argv[index], "inventory") == 0 && index + 1 == argc) {
    result = inventory_root(root_fd);
  } else if (strcmp(argv[index], "exec") == 0 && index + 2 < argc) {
    result = execute_tool(root_fd, argv[index + 1], &argv[index + 1]);
  } else if (strcmp(argv[index], "provider") == 0 && index + 2 < argc &&
             (strcmp(argv[index + 1], "claude") == 0 || strcmp(argv[index + 1], "codex") == 0)) {
    result = execute_provider(root_fd, argv[index + 1], &argv[index + 2]);
  } else if (strcmp(argv[index], "provider") == 0 && index + 3 < argc &&
             strcmp(argv[index + 1], "codex-node") == 0) {
    result = execute_codex_node(root_fd, &argv[index + 2]);
  } else {
    usage(); result = 2;
  }
  close(root_fd);
  return result;
}
