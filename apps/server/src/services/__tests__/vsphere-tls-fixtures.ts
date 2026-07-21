/**
 * Throwaway self-signed certificates for the TLS trust tests (#175).
 *
 * @ai-warning These are TEST FIXTURES. The private keys are generated for this
 * repository's test suite, are committed deliberately, and protect nothing. They
 * must never be used by any running service, and no real key may ever be added
 * to this file.
 *
 * Generated with:
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
 *     -subj "/CN=vcenter.test.local" \
 *     -addext "subjectAltName=DNS:vcenter.test.local,IP:127.0.0.1"
 *
 * Committed rather than generated at runtime because Node cannot mint an X.509
 * certificate from `crypto` alone, and neither shelling out to openssl (absent
 * from the distroless image, and a build-host dependency in CI) nor adding a
 * cert-generating dependency is worth it for a fixture.
 */

/** Self-signed for `vcenter.test.local`, also valid for 127.0.0.1. */
export const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJvBxv/X+xUoft
2LN2xLxyBF6XuOuW1oHTlThU1ldPIe/h95pt8zDZ7PwRw25FTHJVivqSlmPvS1VZ
Y92CLHsdB6BZR1ylaf2Zb6AL2F9zsUMpPiakIwSZOZ0w7HQisP/cHsgJ4mw3LX8J
1Tv8ytOKSLcEFFigwzCgQfTlpt9c+jk87HRVnj2elwBdBxf1rkj8wSo06i6RG1hu
Ip4PZ/Ts5Fp+SLs5l17z2Nt8JIeBJYWWEPd+jo6WmZPjhVJe/gNczoZ2sVQl9tB7
kJlFHPWGdSt6gyVlFfpODuMQBJ4viV4ADxDVAc7iEO5kI2h5Otf5A3wtqNUwaxlq
BvHP8a49AgMBAAECggEAFmLWAwVt7Jb8d4PTEmxtfveGKa7/Eat3F6wY5q0sXh8l
d/1aeTYB50T5id0WeQEtNNnpyWd/6neBHpzK4V2fQc7tV8rn+IEk/6hX6ciWewei
LMr1TcSHB5vRmjK7Bnh+xAX0a8hg+tSFIumzMO+u/srn6D97wEc4t6fqDavxYGc/
jUdCPXrUb9TZYJHUvbpFp6xOc5lJ9PY4pvtjVpFHMGwoqvb5VRkXOExkltMWiotv
qppObjrldLXzzChmrXpCmvtp/VkRTDHDb24WAFBbhnjswit3YefZmLoyASR7EqLq
Vx+YofuUC2rvG5PJgiqfTFwxMTMzZXiFgnXQCI3LYQKBgQDoBKanG5rRRRSiFErz
vz+va81lMBfOpEchJ6iM29BxapsPVSsA1jDv+TscZ3t6j9VLJfIETGuIkjvzdGkp
LPXg3FT52TOl7BCiSkqAtWKEh/H/yKsEPaLGb9oiKHCypIlRH51vfRoepxC6NRAN
r6tyShXlF596HnYO2mOwbLO/EQKBgQDeliSfvQeG8Dr0nP/Ad97TOkDWiONJcL0j
OJsuHuy5/kCYgruuu/OCIdyIEkKsQhVGz0490iZF5z1z3ZToD2DkNHmV4afmL8tV
xPER8njrkgY73cRuwmon5ZsKLnAqcXZTqi8AzlTqnJQ5PB8OVQo3D2EizZQvfDJu
wvwabLwUbQKBgCSNnwfSxIhVvtNuKQTPy6PCcyCO/CE1JnOlwNs4QlWr+vPmchj2
pc0Y0eQ+tWhwwqTNPJzKwWJJz6IiY/L1v2MGs2iNfKKWV2SKGcS/Tt8cX9bxcWgA
oeVrd81L2715SJz8QxxudDACGBOOCpJta7Bc1ag7GYfuxqC+bVg9N/BRAoGBAKOt
RMEx/5b6kF/QE0E05GXvMD6R6pDWlj6QIYyIsQsUK+v6NokHLMlEnSZyRxTkg0DO
sHpFTl+Y61eIWTdMF7O34rCUfyKFgsBPUfYgl0qi1nKvYQMRc35jGN8jxtdvF9Pu
ESJGl6rt+REdZLjlT92tMYCmK5G/glZwi3HjA2sBAoGBAIaV3jpCKuqAJdImCIGC
7Av2XJzv3Ts1J8R26u/g34KOcieULTGLLxLCEc308m1NYzISyXzm2158SSi94gHZ
I1GyBbmiUXlPz1mOCBKkJYnXK+5NxKWpDnYc89ZuUFWeA+hllvESCRFQjmpUTzHm
BGSosvH9FK47YToqsUA8VXE+
-----END PRIVATE KEY-----
`;

export const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDQDCCAiigAwIBAgIUVw/6zPL6m7mzPwGhT1N0qunmO9gwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSdmNlbnRlci50ZXN0LmxvY2FsMB4XDTI2MDcxNzEwMzEz
MloXDTQ2MDcxMjEwMzEzMlowHTEbMBkGA1UEAwwSdmNlbnRlci50ZXN0LmxvY2Fs
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAybwcb/1/sVKH7dizdsS8
cgRel7jrltaB05U4VNZXTyHv4feabfMw2ez8EcNuRUxyVYr6kpZj70tVWWPdgix7
HQegWUdcpWn9mW+gC9hfc7FDKT4mpCMEmTmdMOx0IrD/3B7ICeJsNy1/CdU7/MrT
iki3BBRYoMMwoEH05abfXPo5POx0VZ49npcAXQcX9a5I/MEqNOoukRtYbiKeD2f0
7ORafki7OZde89jbfCSHgSWFlhD3fo6OlpmT44VSXv4DXM6GdrFUJfbQe5CZRRz1
hnUreoMlZRX6Tg7jEASeL4leAA8Q1QHO4hDuZCNoeTrX+QN8LajVMGsZagbxz/Gu
PQIDAQABo3gwdjAdBgNVHQ4EFgQUIU0b43x6+8T7ko1RLF8j6miCwlYwHwYDVR0j
BBgwFoAUIU0b43x6+8T7ko1RLF8j6miCwlYwDwYDVR0TAQH/BAUwAwEB/zAjBgNV
HREEHDAaghJ2Y2VudGVyLnRlc3QubG9jYWyHBH8AAAEwDQYJKoZIhvcNAQELBQAD
ggEBAFT5/JNmAQlUMp6SUFLojzf3px5ET34rWWoKIlLuiVZDpz59cCj+KQ+3qe8m
9bQ//7Llw+tp7ViIj0vVjoH6mItqcl+DcRcQ26pqBlT3ls3yAdaqZXL9jYupF83v
jZ07dx/Aqwl5E8qGz6jnyJhBfCG1edAs3HnS9mmnC3Z4s5g+4SRSle408ELBovRo
2BBrQaKRX4gKz2aIv+hIIoxIQjBsQKf9t1m5n1munPniDrqB/dqocodEkqALNqPP
MKV1Ud8idOEVz2eNiiMbLmDTrBdLsC1aBpfORm3BEvX+glO5Z1KMrvqoQ3RL+U3h
m071uSyex9jJsn8toTf/8DROxAs=
-----END CERTIFICATE-----
`;

/** A DIFFERENT self-signed cert — the negative control for pinning the wrong anchor. */
export const OTHER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUYoGg1ytA+5vnGEuG7FeYpWh7AkgwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQb3RoZXIudGVzdC5sb2NhbDAeFw0yNjA3MTcxMDMxNTBa
Fw00NjA3MTIxMDMxNTBaMBsxGTAXBgNVBAMMEG90aGVyLnRlc3QubG9jYWwwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDghCy4mfgEOirIKKVeGXm9LIF5
r7EG1VAMA2Jjz5lbXG74ZHI4vGFe4lyHlmg2uoeD14fbkIL5kzvsWPIfaWDL5r7r
fz+bLT/GR/DXTLNXanq5T00/JALqnSAZnYoXOwUsSFhqoENVfpj5SQsbHthzrZNl
U30wzpGM+WF4XBief+fHGZwOCsMJMWhF57KpmwEG1R3wLng4f+2bQsELXLV3aBSp
fc7dImWCBStkiJrUeUhOXlPDMYl1/FBECgdWDLqE1ZRaEDgzm7aw8hAOawKuoLvd
6FCYgLyx5eDkdhmX+qoTfSFlIkweQiWKhQFnMKimXtlZx+/QAKn894VuMxW5AgMB
AAGjcDBuMB0GA1UdDgQWBBRqjxbU0sTAPEAQYxaDQKgn/FnuVzAfBgNVHSMEGDAW
gBRqjxbU0sTAPEAQYxaDQKgn/FnuVzAPBgNVHRMBAf8EBTADAQH/MBsGA1UdEQQU
MBKCEG90aGVyLnRlc3QubG9jYWwwDQYJKoZIhvcNAQELBQADggEBAIqAT71aOMFB
zz9F2yMJHvKAXbhodm8s4MBzJOQBwdzOn9QHsJ9/oq3DnRAnI9/9+C0pEXNhjcOg
57SBO63OU+AayKbEzMQZW4xZxMEGM5jujablvUOpbBqYfwmpwmhU5Kbw150W9xwQ
MdMskExd9Y/yjW21z+LK65Rh49+1VssCC4yoYs4+8aG/I2l6Iacy98j/vu9QTcec
EFeM9pyBXq5zWEyzn+vOOEzk5wQm+uIhV5jpNsbhzR9gQbT+avM/6WwznyXc1mgO
qlmi0Rqj50DnqgL7KIdKKVguO5R8vcZm8BbnpsRbInhbDm7Z7cT1WDNuX7Q2OIMS
PUPl7vXoYag=
-----END CERTIFICATE-----
`;

/**
 * A real 3-level chain — root CA → intermediate CA → leaf — for the #272
 * incomplete-chain tests. Unlike the single self-signed fixtures above (leaf ==
 * root, which is exactly why vcsim/CI never reproduced #272), this has a distinct
 * self-signed root, an intermediate, and a CA-signed leaf. That lets a test assert
 * the security predicate on REAL certificate bytes: only the self-signed root is a
 * genuine anchor; the intermediate and the leaf are not, so pinning either (which
 * is what an incomplete chain makes `rootOf` do) must be refused.
 *
 * @ai-warning TEST FIXTURES. These are throwaway PUBLIC certificates only — no
 * private keys. Verifying a self-signature needs only the cert's own embedded
 * public key, so no key material is required (or committed) for these tests. All
 * three signing keys were discarded at generation time.
 *
 * Generated (2026-07-21) with:
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -keyout root.key -out root.crt \
 *     -subj "/CN=LCM Test Root CA" -addext "basicConstraints=critical,CA:TRUE"
 *   openssl req -newkey rsa:2048 -nodes -keyout int.key -out int.csr \
 *     -subj "/CN=LCM Test Intermediate CA"
 *   openssl x509 -req -in int.csr -CA root.crt -CAkey root.key -CAcreateserial -days 3650 \
 *     -extfile <(printf "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n") -out int.crt
 *   openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=vcenter.test.local"
 *   openssl x509 -req -in leaf.csr -CA int.crt -CAkey int.key -CAcreateserial -days 3650 \
 *     -extfile <(printf "subjectAltName=DNS:vcenter.test.local,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n") -out leaf.crt
 */

/** Self-signed root of the 3-level chain — a genuine anchor. */
export const ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUOa4mcq8XBPN/0o5MUvsAYgM6O+MwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQTENNIFRlc3QgUm9vdCBDQTAeFw0yNjA3MjExMTQ5MzBa
Fw00NjA3MTYxMTQ5MzBaMBsxGTAXBgNVBAMMEExDTSBUZXN0IFJvb3QgQ0EwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCdtdVg0Jp5hzlk1Ag+IBMXMpau
FHpTPbX91HnIRiv0v10wwbVaYnBlv0amYztWBbxVCCk/JxSsifSyABLl5HrVSazW
p9FWxu86iBhm2/okYruDm2e+ViiU578O/WHET+te87ltEWEGwcE2EzAsmH0zQLpJ
Ii1HxUCq9tW7zYNdndrUc0baB1DkjZKIJWoIIGELia5XSm+piJ9psyygrua8zp3l
QYIvYfx4vWWQDx20/g8yKUepBi/Qyx2GPo8yiYMHCGjehGyrkyFMDZESNeKJgmLt
E//9AI8gqm/OmCiMScK6bSjubyMebtSackj7apqfelLuKJb3WYajH2zrxDzbAgMB
AAGjUzBRMB0GA1UdDgQWBBTOKZaht6aC1GtvrZTO8AzJsdMvRDAfBgNVHSMEGDAW
gBTOKZaht6aC1GtvrZTO8AzJsdMvRDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQAkLMiHxjNFiDS+EBF4dKomTM+4/NiUFeOI29qfUAlszBNuLaht
XZWuvtTOVeR4QnbKXnSoyKx+e0AiKFHvNg9TboZ2cKydvk7MCmmeRpsqEIqvl2bd
ohVa9aUg5yIjF6XGvSRCNAqR9zL524NfxepQmM2Ly5k0OlcQXhqReBejEkQvlzm4
6LyzHAJC0mO4+vq3lVLGmKne+Lv4+SD765ST+nxeoeceJ84m7S9LJ2CawMCTWiju
RW2xDtFtmoHs6irIdabU77UsvvYtz48BKNbqE8/aplFvQwLhO/LomKHWTGz0FKV9
5xbeIJU40ONCmfE7aer5QQjoIhpqOwHuBHGN
-----END CERTIFICATE-----
`;

/** Intermediate CA — CA-signed, NOT self-signed: must never be pinned as an anchor. */
export const INTERMEDIATE_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUW/hKo0cehjwHjKhrJkhqs/mJtzYwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQTENNIFRlc3QgUm9vdCBDQTAeFw0yNjA3MjExMTQ5MzBa
Fw0zNjA3MTgxMTQ5MzBaMCMxITAfBgNVBAMMGExDTSBUZXN0IEludGVybWVkaWF0
ZSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALqHgUbEMKd8bQM2
xgwV4cTVxxeItb6ksKrGSuKFkOiTpVzQeN6qiI6L+zT50mujonahhb3JDpK3yure
wKxvtLCKSHg/ZrSdB/4vTvf11WAKGp1TF5LgGwyuRodadZVgoN8v0TzidSTxjQKZ
77CnC77J6dGhe8s3Pphv+4wNxnPH629jtQRAj+4jDn8TtqgnuUMB+D/FUKYpg/T5
PCHJeRSrMZ5H5wZCCMm4l6gPPt9OXwmHizSBLUPBRU7J2VwoZDw/797UHiiGrvk1
o/eDb3UxFlp1JfCsSVQRbhnxMkSSWpkS4fbSxKyXubZ8s2DWWJ+J9nexJcS3bhwB
CRUb0rUCAwEAAaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYw
HQYDVR0OBBYEFC24Xl55NL1jeu+xgTEJbXKrTIgrMB8GA1UdIwQYMBaAFM4plqG3
poLUa2+tlM7wDMmx0y9EMA0GCSqGSIb3DQEBCwUAA4IBAQBUYe5Lz5ieC7DUoZzj
9ZSdCJptkp2LCxJbDH7j6HQdcMEDJLxaxOJlm+nNUilP/EX+rV0S/zFjdjk/0H/L
xYYJLWsr27e8acjmmn1K6NcpPPkvPXO/uTJdhDRstsi66kMT9kmbW4htn+tCMZsy
j8vLf7rGXkbKMBLwrdJWczsXqUVL8iHSTcz3qzhNgNQtnrl3vRftwbFpuyA4+CwY
V75FJEhjFlaynKt9sLia8CUhrseRpq9cLM0LaEuBULuw9MZuA4sDTjoKmDqreMG9
08junpikAg6+cxanwYnmQwhr2fYpD0lhcNWhww8YrBBVefBEkVWTvmSsFjlpY3Ar
CgXX
-----END CERTIFICATE-----
`;

/**
 * Leaf, CN=vcenter.test.local, SAN DNS:vcenter.test.local,DNS:localhost,IP:127.0.0.1,
 * signed by the intermediate — a CA-signed end-entity cert, never a valid anchor.
 */
export const CHAIN_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUGLk1AuGaf5bAXYoqmLXiJ7JwX+UwDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYTENNIFRlc3QgSW50ZXJtZWRpYXRlIENBMB4XDTI2MDcy
MTExNDkzMFoXDTM2MDcxODExNDkzMFowHTEbMBkGA1UEAwwSdmNlbnRlci50ZXN0
LmxvY2FsMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2s//gDz4P6zh
dZ7coH85b7ehnevldq2qsBUKWD5+T+NgAaCnbJgCdi1EGK8hxPLFrONulQIIyReV
V2arEIYnZww2BkmihGZKseeZjbvaVEpT8kaLsokGBgEr/e1hE0NVNWgw5B9xA/Ae
vML/BJc/ESak/Aj6V9TIQdvz7Oq6AbynYHxzrxCda9T6+R0LzdYzR4ZPDmZ2LT+I
CXvZAbkObjZejchsfMm4Ibbx7JaHnf/njSqynLIIQGXVQ3Z8CW+3AmhNgAGzZK7j
N1PsEJou14rfN8WRd2HPX5JJpC6aOY8Cv6zCrVU5boOUPHfCd6zU0XGDJ+AjalMD
unfXqWd/uwIDAQABo30wezAuBgNVHREEJzAlghJ2Y2VudGVyLnRlc3QubG9jYWyC
CWxvY2FsaG9zdIcEfwAAATAJBgNVHRMEAjAAMB0GA1UdDgQWBBQejaGhCKpgb0oc
eQvkODnHdmg5XzAfBgNVHSMEGDAWgBQtuF5eeTS9Y3rvsYExCW1yq0yIKzANBgkq
hkiG9w0BAQsFAAOCAQEAq94Y/zR8K2wAiqgfI+sMERdj4sba3xHB5XYZbhXAHZOH
rGxvm0/gG3Dhuaq/aO1oXfJ5mNhs2/WJN2oAoGXA+oSMlefWVyKWNLjmdFK9y+TM
Qkm8wHsL4n+DrC4efqLAoqePfaqj2Lwd4H93x4S4Y5GlY7lLPN9YcbvuWGOBuDA2
I0Ie4Kd4wYbmfi33xPZBcuNNF52vYmtl7im5EWlnsG6sGCTASZBI3wrfgy43ipWe
D+OqLtEdnNGw6iP5JiZiarpLkRGLLscg3UpA4n/TSRxkgwB2UUzNgBhxUv/kYybD
oI0FOSORWErix4FBSX/fHw3lt+FzL6fDvTbHGpYOYg==
-----END CERTIFICATE-----
`;
