# Signing the Windows installer

**Today the installer is not signed.** The build is ready to sign it the moment a certificate is
configured; nothing in the code has to change. A certificate cannot be created by the build or
by anyone on the owner's behalf: a certificate authority has to verify who the publisher is, and
that takes a person (identity documents, a payment method) and a few business days.

## What signing does, and what it does not

* It puts the publisher's verified name on the installer and on `AgencyOS.exe`. Windows then shows
  that name instead of "Unknown publisher".
* It does **not** by itself switch SmartScreen off. SmartScreen also learns from how many people
  download and run a file, so a new publisher can still see a warning for a while. Extended
  Validation certificates stopped giving an instant pass in 2024, so paying more for one does not
  change that.
* The build proves what it did: the smoke test asks Windows whether the installer and the
  installed `AgencyOS.exe` carry a valid, timestamped signature, and the release notes say
  "code-signed" only when that was seen. An unsigned build says so, as before.

## Option A: Azure Artifact Signing (recommended)

Built for CI: no hardware token, and the build signs in without a stored password.
Microsoft's comparison lists it at roughly 10 US dollars a month; organizations in the USA,
Canada, the EU and the UK can use it, individuals only in the USA and Canada; identity
validation takes a few business days. Check Microsoft's current terms before relying on those.

1. Create an Azure subscription and an **Artifact Signing** account. Note its regional endpoint,
   for example `https://eus.codesigning.azure.net/`.
2. Complete identity validation, then create a **certificate profile** (public trust).
3. In Microsoft Entra, register an app. Add a **federated credential** for GitHub Actions:
   organization/user `smartave99`, repository `AgencyOS`, entity type *Branch*, branch `master`.
4. Give that app the role **Artifact Signing Certificate Profile Signer** on the signing account.
5. In the repository's *Settings → Secrets and variables → Actions*, add

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `AZURE_CLIENT_ID` | the app registration's client ID |
   | Secret | `AZURE_TENANT_ID` | your Entra tenant ID |
   | Secret | `AZURE_SUBSCRIPTION_ID` | the Azure subscription ID |
   | Variable | `ARTIFACT_SIGNING_ENDPOINT` | the endpoint from step 1 |
   | Variable | `ARTIFACT_SIGNING_ACCOUNT` | the signing account's name |
   | Variable | `ARTIFACT_SIGNING_PROFILE` | the certificate profile's name |

6. Run the *windows-installer* workflow as usual. The step *Signing mode* prints `azure`, and the
   smoke test's signature step must pass.

## Option B: a certificate file

For a certificate you can export as a `.pfx` (an organization's own PKI, for example). Certificates
bought from a public authority since June 2023 must keep their private key on hardware, so most
of them **cannot** be exported and cannot be used this way; use Option A, or tell us which
cloud-signing service your authority offers and a step for it can be added.

Add the secrets `WINDOWS_PFX_BASE64` (the file, base64-encoded) and `WINDOWS_PFX_PASSWORD`. The
step *Signing mode* then prints `pfx`.

## Trying the pipeline without a certificate

Run the workflow with **sign_selftest** on (and **publish** off; a self-test run refuses to
publish). The runner makes a throwaway certificate, trusts it on that machine only, signs both
files, and the smoke test checks Windows accepts the result. That proves every signing step and
check works; the signature itself means nothing outside that run, and the release notes never
call it a real signature.

## Sources

* Microsoft Learn: [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
* GitHub: [azure/artifact-signing-action](https://github.com/Azure/trusted-signing-action)
