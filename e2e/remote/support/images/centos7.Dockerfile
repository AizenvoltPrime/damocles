FROM centos:7@sha256:be65f488b7764ad3638f236b7b515b3678369a5124c47b8d32916d6487418ea4
# CentOS 7's mirrors are retired; its packages stay on vault.centos.org.
RUN sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\s*baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-*.repo \
  && yum install -y openssh-server procps-ng \
  && yum clean all \
  && rm -f /etc/ssh/ssh_host_* \
  && mkdir -p /etc/ssh/authorized_keys /srv/app \
  && useradd -m -s /bin/bash -u 1000 dev \
  && usermod -p '*' dev \
  && chown dev:dev /srv/app
COPY sshd_config /etc/ssh/sshd_config
CMD ["sleep", "infinity"]
