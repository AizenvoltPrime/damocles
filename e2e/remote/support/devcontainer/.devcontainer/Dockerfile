# The Node devcontainer the @devcontainer specs build: Alpine (musl), so the musl server package installs; pinned by digest.
FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
# every image the specs build carries the label their teardown removes by
LABEL damocles.e2e=devcontainer
# git for the credential relay case, ssh-add and ssh for the agent relay case; the build log shows its output. The workspace
# is a bind mount the container user does not own, which git refuses without safe.directory.
RUN apk add --no-cache git openssh-client && git config --system --add safe.directory '*'
