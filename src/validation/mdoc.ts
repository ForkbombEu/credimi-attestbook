// mdoc issuance-artifact structural parsing.
//
// The pinned @owf/mdoc parser owns CBOR and COSE data-model decoding. This
// adapter extracts only non-sensitive facts needed by the validation engine;
// it does not verify the IssuerAuth signature, item digests, status, trust, or
// device authentication. Those remain separate validation dimensions.

import { IssuerSigned } from '@owf/mdoc'

import type { ValidationFinding } from './types'

/** Parsed non-sensitive facts from an OpenID4VCI `mso_mdoc` credential value. */
export interface ParsedMdoc {
  readonly docType: string
  readonly namespaceCount: number
  readonly elementCount: number
  /** An MSO always carries a device key; proof of possession is not checked here. */
  readonly keyBindingPresent: true
}

export interface MdocParseFailure {
  readonly ok: false
  readonly kind: 'invalid'
  readonly findings: readonly ValidationFinding[]
}

export interface MdocParseSuccess {
  readonly ok: true
  readonly value: ParsedMdoc
}

export type MdocParseOutcome = MdocParseSuccess | MdocParseFailure

function invalid(code: string, message: string): MdocParseFailure {
  return {
    ok: false,
    kind: 'invalid',
    findings: [
      {
        code,
        message,
        severity: 'error',
        dimension: 'credential_parsing',
        path: '/credential',
      },
    ],
  }
}

/**
 * Parses an OpenID4VCI `mso_mdoc` issuance artifact encoded as base64url CBOR.
 *
 * `IssuerSigned.fromEncodedForOid4Vci` validates the mdoc CBOR structure. It
 * does not verify COSE or X.509 material, intentionally leaving those checks
 * for their explicit validation dimensions.
 */
export function parseMdoc(credential: string): MdocParseOutcome {
  let issuerSigned: IssuerSigned
  try {
    issuerSigned = IssuerSigned.fromEncodedForOid4Vci(credential)
  } catch {
    return invalid(
      'invalid_mdoc_issuer_signed',
      'The credential is not a structurally valid base64url-encoded mso_mdoc IssuerSigned artifact.',
    )
  }

  const docType = issuerSigned.issuerAuth.mobileSecurityObject.docType
  if (typeof docType !== 'string' || docType.trim() === '') {
    return invalid(
      'missing_mdoc_doctype',
      'The mso_mdoc Mobile Security Object has no document type.',
    )
  }

  const namespaces = issuerSigned.issuerNamespaces?.issuerNamespaces
  const namespaceCount = namespaces?.size ?? 0
  const elementCount =
    namespaces === undefined
      ? 0
      : Array.from(namespaces.values()).reduce((count, elements) => count + elements.length, 0)

  return {
    ok: true,
    value: {
      docType,
      namespaceCount,
      elementCount,
      keyBindingPresent: true,
    },
  }
}
