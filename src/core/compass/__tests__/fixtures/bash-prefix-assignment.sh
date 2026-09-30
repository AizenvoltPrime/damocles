#!/usr/bin/env bash

function say_hello() {
    echo "hello"
}

FOO=bar say_hello
PATH=/x:$PATH say_hello
