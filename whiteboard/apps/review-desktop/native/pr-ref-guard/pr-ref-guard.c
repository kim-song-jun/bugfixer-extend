/* Copyright (c) dev.fast. Licensed under the MIT License.
 * Shipped pre-push guard. No child processes, files, credentials, or project configuration.
 * Git protocol: <local-ref> <local-oid> <remote-ref> <remote-old-oid> LF.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int reject(void) {
	fputs("Publication refused: remote ref does not match the approved absent-ref transaction.\n", stderr);
	return 1;
}

static int hex_oid(const char *value) {
	size_t n;
	if (!value) return 0;
	n = strlen(value);
	return (n == 40 || n == 64) && strspn(value, "0123456789abcdef") == n;
}

int main(int argc, char **argv) {
	const char *local = getenv("BUGFIXER_PR_LOCAL_REF");
	const char *head = getenv("BUGFIXER_PR_HEAD");
	const char *remote = getenv("BUGFIXER_PR_REMOTE_REF");
	const char *destination = getenv("BUGFIXER_PR_DESTINATION");
	const char prefix[] = "refs/heads/bugfixer/pr/";
	char input[2048];
	char *fields[4];
	size_t used = 0, count = 0, i, start = 0;
	int next;
	if (argc != 3 || !hex_oid(head) || !local || strcmp(local, head) != 0 || !remote || !destination
		|| strlen(destination) > 1024 || strcmp(argv[1], destination) != 0 || strcmp(argv[2], destination) != 0
		|| strncmp(remote, prefix, sizeof(prefix) - 1) != 0 || strlen(remote) != sizeof(prefix) - 1 + 36) return reject();
	for (i = sizeof(prefix) - 1; i < sizeof(prefix) - 1 + 36; i++) {
		size_t offset = i - (sizeof(prefix) - 1);
		if (offset == 8 || offset == 13 || offset == 18 || offset == 23) { if (remote[i] != '-') return reject(); }
		else if (!strchr("0123456789abcdef", remote[i])) return reject();
	}
	while ((next = getchar()) != EOF) {
		if (used >= sizeof(input) - 1 || next == '\0' || next == '\r' || next == '\t') return reject();
		input[used++] = (char)next;
	}
	if (ferror(stdin) || used == 0 || input[used - 1] != '\n') return reject();
	input[used - 1] = '\0';
	for (i = 0; i < used; i++) {
		if (input[i] == '\n') return reject(); /* A second tuple is never authorized. */
		if (input[i] == ' ' || input[i] == '\0') {
			if (i == start || count == 4) return reject();
			input[i] = '\0'; fields[count++] = input + start; start = i + 1;
		}
	}
	if (count != 4 || strcmp(fields[0], local) != 0 || strcmp(fields[1], head) != 0 || strcmp(fields[2], remote) != 0
		|| strlen(fields[3]) != strlen(head) || strspn(fields[3], "0") != strlen(head)) return reject();
	return 0;
}
