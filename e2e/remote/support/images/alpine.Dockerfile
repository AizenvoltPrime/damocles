# scripts/test-remote.mjs passes ALPINE_TARGET_IMAGE (scripts/server-targets.mjs), the clean Alpine the server packages self-test in.
ARG ALPINE_IMAGE
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache openssh-server libstdc++ libgcc bash git procps \
  && rm -f /etc/ssh/ssh_host_* \
  && mkdir -p /etc/ssh/authorized_keys /srv/app /opt/damocles \
  && adduser -D -s /bin/bash -u 1000 dev \
  && sed -i 's/^dev:!/dev:*/' /etc/shadow \
  && chown dev:dev /srv/app /opt/damocles
COPY sshd_config /etc/ssh/sshd_config
CMD ["sleep", "infinity"]
