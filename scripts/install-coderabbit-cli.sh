#!/usr/bin/env bash
# Idempotent CodeRabbit CLI bootstrap for Cursor Cloud Agent environments.
# Docs: https://docs.coderabbit.ai/cli/overview
#
# Downloads a pinned release zip over HTTPS, verifies SHA-256 against the
# published SHA256SUMS for that version, then installs the binary. Does not
# pipe a mutable install.sh into a shell.
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

# Pin the CLI release. Bump intentionally when upgrading.
readonly CODERABBIT_CLI_VERSION="${CODERABBIT_CLI_VERSION:-0.7.6}"
readonly CODERABBIT_RELEASE_BASE="https://cli.coderabbit.ai/releases/${CODERABBIT_CLI_VERSION}"

curl_https() {
  # Restrict redirects to HTTPS (blocks http:// downgrade redirects).
  curl --proto '=https' --tlsv1.2 -fsSL "$@"
}

# Prefer GNU sha256sum; fall back to macOS/BSD shasum -a 256. Prints digest only.
file_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    echo "neither sha256sum nor shasum is available" >&2
    return 1
  fi
}

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux) os="linux" ;;
    darwin) os="darwin" ;;
    *)
      echo "unsupported OS: $os" >&2
      return 1
      ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      echo "unsupported arch: $arch" >&2
      return 1
      ;;
  esac
  printf '%s %s\n' "$os" "$arch"
}

install_coderabbit_cli() {
  local os arch asset sums_file zip_file expected actual install_dir
  read -r os arch < <(detect_platform)
  asset="coderabbit-${os}-${arch}.zip"

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  sums_file="${tmp}/SHA256SUMS"
  zip_file="${tmp}/${asset}"

  curl_https -o "$sums_file" "${CODERABBIT_RELEASE_BASE}/SHA256SUMS"
  curl_https -o "$zip_file" "${CODERABBIT_RELEASE_BASE}/${asset}"

  expected="$(awk -v f="./${asset}" '$2 == f { print $1; exit }' "$sums_file")"
  if [[ -z "$expected" ]]; then
    echo "no SHA-256 entry for ${asset} in ${CODERABBIT_CLI_VERSION} SHA256SUMS" >&2
    return 1
  fi
  actual="$(file_sha256 "$zip_file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for ${asset}" >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    return 1
  fi

  unzip -qo "$zip_file" -d "$tmp"
  if [[ ! -f "${tmp}/coderabbit" ]]; then
    echo "coderabbit binary missing from ${asset}" >&2
    return 1
  fi

  install_dir="${HOME}/.local/bin"
  mkdir -p "$install_dir"
  # Atomic-ish replace: write temp then mv.
  install -m 0755 "${tmp}/coderabbit" "${install_dir}/coderabbit.new"
  mv -f "${install_dir}/coderabbit.new" "${install_dir}/coderabbit"
  ln -sfn "${install_dir}/coderabbit" "${install_dir}/cr"
}

if ! command -v coderabbit >/dev/null 2>&1; then
  # No install.sh / interactive browser login path: only auth when an API key
  # is provided below (CODERABBIT_API_KEY absent => remain signed out).
  install_coderabbit_cli
  export PATH="${HOME}/.local/bin:${PATH}"
fi

if [[ -n "${CODERABBIT_API_KEY:-}" ]]; then
  auth_args=(--api-key "${CODERABBIT_API_KEY}")
  if [[ -n "${CODERABBIT_REGION:-}" ]]; then
    auth_args+=(--region "${CODERABBIT_REGION}")
  fi
  coderabbit auth login "${auth_args[@]}"
fi

coderabbit --version
