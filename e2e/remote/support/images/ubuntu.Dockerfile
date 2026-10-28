FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server curl ca-certificates git procps libpam-google-authenticator \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssh/ssh_host_* \
  && mkdir -p /run/sshd /etc/ssh/authorized_keys /srv/app /opt/damocles \
  && useradd -m -s /bin/bash -u 1000 dev \
  && useradd -m -s /bin/bash -u 1001 deploy \
  && usermod -p '*' dev \
  && usermod -p '*' deploy \
  && chown dev:dev /srv/app /opt/damocles
COPY sshd_config /etc/ssh/sshd_config
CMD ["sleep", "infinity"]
