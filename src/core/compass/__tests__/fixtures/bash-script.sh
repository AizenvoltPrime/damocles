#!/usr/bin/env bash

source ./bash-source-target.sh
. ./bash-source-target.sh

function greet() {
    echo "Hello"
    say_hello
}

function say_hello() {
    printf "%s\n" "world"
}

greet
