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
// nosemgrep: generic.secrets.security.detected-private-key.detected-private-key
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
