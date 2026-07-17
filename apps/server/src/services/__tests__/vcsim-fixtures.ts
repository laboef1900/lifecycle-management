/**
 * TLS material for the vcsim inventory-collector integration tests (#190).
 *
 * @ai-warning These are TEST FIXTURES. The private key is generated for this
 * repository's test suite, is committed deliberately, and protects nothing. It
 * must never be used by any running service, and no real key may ever be added
 * to this file.
 *
 * Why a distinct cert from `vsphere-tls-fixtures.ts`: vcsim is reached over a
 * Testcontainers-mapped port on the Docker host, and the collector connects to it
 * by DNS name (`localhost`) — Node refuses to set the TLS SNI `servername` to a
 * literal IP (`ERR_INVALID_ARG_VALUE`), and production always addresses vCenter by
 * FQDN, so the test must too. This cert therefore carries `DNS:localhost` in its
 * SAN (the #175 fixture does not). vcsim serves it via `-tlscert`/`-tlskey`, the
 * collector pins it as the `ca:` trust anchor, and the full production TLS path
 * (`rejectUnauthorized: true` + root pin + hostname verification) is exercised
 * unchanged — only the port differs from 443.
 *
 * Generated with:
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
 *     -subj "/CN=localhost" \
 *     -addext "subjectAltName=DNS:localhost,DNS:vcenter.test.local,IP:127.0.0.1"
 *
 * Self-signed, so the presented chain is a single cert: root == leaf, and pinning
 * it as `ca:[VCSIM_CERT_PEM]` terminates OpenSSL chain-building at a trusted
 * self-signed anchor (the ESXi-style shape in design §D11).
 */

/** Self-signed for `localhost` (also `vcenter.test.local`, `127.0.0.1`). */
export const VCSIM_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIUGWR/SEBa4hseHNbezU0tqVlJRiUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxNzE1MTIzOFoXDTQ2MDcx
MjE1MTIzOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAy3tPtVvBR3qbG2YIQUFniWSBS1Y8lBd2utx7mw9YU/uZ
qVo6bzkcTO5j5BZHGlrjVDrmEKJXus5tX5Zk31MGybsPTg4tJYRmNyTdoY0jQORN
jOP1u6wBHzTqz2nVlfHpUwiCapTHAOQxp5ni7NwIc4R7Sqb1x56fhz5oaD4g6eGA
FsEvL19ektbQhAbKvNlrohjj8s/8P6aUzpSWjVAWtCZbI9TWB5dgRkm32HjSFV/p
lZ+UbbiH/ExusxAInV0Q7On59T1CPHMHWijuANB/0CLQ6777s3H3EauhZ8mYyB91
LjWDBrXZqnjsbVzf1A2PzwY1Z5HnTwUwE4v4oNvTGQIDAQABo4GEMIGBMB0GA1Ud
DgQWBBQ7M0+94FN7vDhzSmTyO3Qalh4m7zAfBgNVHSMEGDAWgBQ7M0+94FN7vDhz
SmTyO3Qalh4m7zAPBgNVHRMBAf8EBTADAQH/MC4GA1UdEQQnMCWCCWxvY2FsaG9z
dIISdmNlbnRlci50ZXN0LmxvY2FshwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQBO
xSUTdoc/lfksZ3L94/DZgMP3cjNd6D75mYkHr8vvm6TcLgLM+ias7Y/TUureGCXY
C/dQDIex+aBDBV/qPewKvESG2p64MGgHW/hslHWqLvrdrluizmDwCYv1nPpjsv/r
MxYCUSjflGoPSEg+dAwicvWT9T7IYWydHNp/bsIUJ6GY3cobRMsMdsWsdh+1Y1qy
Y/093B3IJurvG1BtUX89pwXL9CHS9/bbhQhzCzZD3Aw2LPpo6tWmrAWJabUDoj7V
FWs9f+0j3QXdMVj+mn5BMibmNqgSHb/PGBpeKALraDa2ljvUlVVbxmbspbya/hd9
GRADh9/QGoN7w8iq2kAa
-----END CERTIFICATE-----
`;

export const VCSIM_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLe0+1W8FHepsb
ZghBQWeJZIFLVjyUF3a63HubD1hT+5mpWjpvORxM7mPkFkcaWuNUOuYQole6zm1f
lmTfUwbJuw9ODi0lhGY3JN2hjSNA5E2M4/W7rAEfNOrPadWV8elTCIJqlMcA5DGn
meLs3AhzhHtKpvXHnp+HPmhoPiDp4YAWwS8vX16S1tCEBsq82WuiGOPyz/w/ppTO
lJaNUBa0Jlsj1NYHl2BGSbfYeNIVX+mVn5RtuIf8TG6zEAidXRDs6fn1PUI8cwda
KO4A0H/QItDrvvuzcfcRq6FnyZjIH3UuNYMGtdmqeOxtXN/UDY/PBjVnkedPBTAT
i/ig29MZAgMBAAECggEAAVp7OE1z2esl6SNX4xzxiu3dft4ED7VAIbFs4sN2iYqG
ZUVu6VNV1galuykGUSJq1Cl7rETv8AxMFTMrFvBihgCU5IlcsEGCel7KxplejrBB
CPDX6ayYjlfPnv4wZGNrG4M5O/2t+WkAL1J9iupocKsefcrEvAdRlnBVK+hyOg5M
DyNI6jFS0DN2MoUxHAqBpJE3vThIpg5wCflmwlBF1nqAC7VH2oebzPN36xsPF4mt
bPvSy5PROqB0TR/cVx5ngKNJs3px3IRSWVmRrNA1zE1+4jNMSD+L4mPgChX0+Jmr
42zVR/mxDIEr9sgAuiXFqDuIGGAkRA/lyL4SZKIj3QKBgQDkZwSIHv9cP5ZsELS5
YTmd6CrngwElEuYzPQ6XDADymiuupBkDtwaoQfLXHlConxiFnUL5/WeO2uLCV7qg
Qb+m8Ki2+JfF2/F1XsEyF8BwNAmloEAY56IwOfb4u68OlFgp7kr5+3h0YZXwX7UQ
kpzpdiYnuZBULHE7v83aQlM0pwKBgQDkEXEDwcra/SFaEyHCgo8xfFCAVSYvr8NU
HxDRYPT7QYfUzDTBOjZjFm/nuPZLrTtdTnXeSxNwrE/xVOmp/km9kj/r8Ie0ZEIB
a8Gjl0gDS2+j6hYm7zc1rDzjdLe+guaivypNCVwapzUHMFLxpgX3CRjGpA0cfLy3
qeM9DATyPwKBgGl9fyVTk8PKhrIgwSfB1PeurGpDIns6EGJn994hqCpktHozxm3l
0chStVNP6BcJbC0CJlYKCRN82zDBjivIUjlLe9EOXiL/Y7U+72IwgCwSjMYXjqMy
EMHPc9cL8F1+fH3ZVn3A/LBcBgGAYsNlw908OYEtfpCx+haLjwsYiQ+PAoGAKmoD
9ornyuogdbvxH1dggfd4kSVEwMGTNeXBHu9FICUDudNwTC8jRjI6BYIka9Z/n86j
pP+ZUe75vwvnmLGtzQ+Ry7MjyayLifAcRuwvfE1fKcCy9fKu9dBeUn62XTvC4Klk
mIcRFfParMeT5VTW7yZF8Us5FP8tqYpytDuz/8kCgYEAo2FXaqCHFO8qKALMsL79
E52MpTJQzQ2eIG4lCwVTmwdyrFBhkX71xQ+GpSmKPpBKS3gvqqyAk0nVCk4zRI5A
TZ9QdpwFE1Hm+uSsFBA4WFoF93327HZnttk0aw7NB7ugvMqvTdAExFytAPiwq5Vp
ggTMN5j5HJDAAqqJbRm5f/U=
-----END PRIVATE KEY-----
`;

/**
 * Digest-pinned vcsim image. `vmware/vcsim` is a first-party govmomi component
 * (Apache-2.0) but a vendor-namespace image, NOT a Docker Official Image — so it
 * is pinned by digest like every other image in this repo. Test-only, so the DHI
 * base-image policy does not apply. Re-resolve with
 * `docker buildx imagetools inspect vmware/vcsim:v0.55.1` if it rotates.
 */
export const VCSIM_IMAGE =
  'vmware/vcsim@sha256:fcca7b87bfb16c3f7b8c8aa94d9d95855891c86fcb216bd6d8dc7b27af385085';
