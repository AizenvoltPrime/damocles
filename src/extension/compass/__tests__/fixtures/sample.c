#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_SIZE 256

struct Point {
    int x;
    int y;
};

typedef struct {
    char name[64];
    int age;
} Person;

typedef struct Point PointAlias;

static int validate(const char *input) {
    return input != NULL && strlen(input) > 0;
}

char *process(const char *input) {
    if (!validate(input)) {
        return NULL;
    }
    char *result = malloc(MAX_SIZE);
    strncpy(result, input, MAX_SIZE - 1);
    return result;
}

int main(int argc, char *argv[]) {
    struct Point p = {0, 0};
    char *out = process("hello");
    if (out) {
        printf("%s\n", out);
        free(out);
    }
    return 0;
}
