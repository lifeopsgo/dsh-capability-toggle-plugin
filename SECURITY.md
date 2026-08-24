# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Older | No |

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** private reporting form for this repository. If private vulnerability reporting is unavailable, contact the repository owner privately through their GitHub profile.

Include:

- affected version or commit;
- reproduction steps;
- expected and actual behavior;
- security impact;
- any suggested mitigation.

Do not include credentials, access tokens, private URLs, or production data in the report. Please allow reasonable time for investigation before public disclosure.

## Security model

This plugin changes an agent's visible and executable capability surface. Its local HTTP routes inherit the DSH Web GUI trust boundary and are intended for a GUI bound to localhost. If the GUI is exposed beyond localhost, place authentication and transport security in front of it.
