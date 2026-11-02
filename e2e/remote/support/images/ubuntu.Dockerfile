FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server curl ca-certificates git procps libpam-google-authenticator python3 xdg-utils \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssh/ssh_host_* \
  && mkdir -p /run/sshd /etc/ssh/authorized_keys /srv/app /opt/damocles \
  && useradd -m -s /bin/bash -u 1000 dev \
  && useradd -m -s /bin/bash -u 1001 deploy \
  && usermod -p '*' dev \
  && usermod -p '*' deploy \
  && chown dev:dev /srv/app /opt/damocles
# the docker CLI a @devcontainer spec drives the engine's mounted socket with, pinned by SHA-256 per architecture
RUN arch="$(uname -m)" \
  && case "$arch" in \
    x86_64) sum=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb ;; \
    aarch64) sum=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73 ;; \
    *) echo "no pinned docker CLI for $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/$arch/docker-29.9.2.tgz" \
  && echo "$sum  /tmp/docker.tgz" | sha256sum -c - \
  && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker \
  && rm /tmp/docker.tgz
COPY sshd_config /etc/ssh/sshd_config
CMD ["sleep", "infinity"]
