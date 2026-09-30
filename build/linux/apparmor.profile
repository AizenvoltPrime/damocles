abi <abi/4.0>,
include <tunables/global>

# Grants only unprivileged user namespaces, which the Chromium sandbox needs on Ubuntu 24.04 and later.
profile ${executable} /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
