import { ValidationStatusBadge, SeverityBadge, StatusBadge } from './Badges'
import { formatDate } from '../catalog'
import { describeReference, formatDigest } from '../detail'
import {
  dimensionTitle,
  formatValidatedAt,
  validationSummary,
  type ValidationSummary,
} from '../playground'
import type { CredentialValidationResult, ValidationDimension, ValidationStatus } from '../types'

const OVERALL_EXPLANATIONS: Readonly<Record<ValidationStatus, string>> = {
  PASS: 'Every applicable dimension executed and passed.',
  FAIL: 'At least one executed dimension failed. This credential is not valid for the pinned rulebook version.',
  NOT_TESTED: 'At least one applicable dimension did not run, so this result is not a pass.',
  INCONCLUSIVE: 'At least one executed dimension was inconclusive, so this result is not a pass.',
  NOT_APPLICABLE: 'No dimension was applicable to this request.',
}

function SafeUri({ uri }: { readonly uri: string }) {
  const target = describeReference(uri)
  if (target.href === null) {
    return <span className="reference-uri reference-uri--inert">{target.label}</span>
  }
  return (
    <a
      className="reference-uri"
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      title={target.href}
    >
      {target.label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function UntestedNotice({ summary }: { readonly summary: ValidationSummary }) {
  if (summary.notExecuted === 0 && summary.notApplicable === 0) {
    return null
  }
  return (
    <div className="notice notice--warning">
      <p className="notice-title">Untested dimensions are not passes.</p>
      <p>
        {summary.notExecuted} of {summary.applicable} applicable dimensions did not execute
        {summary.notApplicable === 0
          ? '.'
          : `, and ${summary.notApplicable} ${
              summary.notApplicable === 1 ? 'dimension is' : 'dimensions are'
            } not applicable to a single credential artifact.`}
      </p>
    </div>
  )
}

function DimensionRow({ dimension }: { readonly dimension: ValidationDimension }) {
  const findingCount = dimension.findings.length
  return (
    <tr className={dimension.executed ? undefined : 'dimension-row--not-executed'}>
      <th scope="row">
        {dimensionTitle(dimension.id)}
        <span className="dimension-id">
          <code>{dimension.id}</code>
        </span>
      </th>
      <td>
        <ValidationStatusBadge status={dimension.status} />
      </td>
      <td>{dimension.executed ? 'Executed' : 'Not executed'}</td>
      <td>{dimension.applicable ? 'Applicable' : 'Not applicable'}</td>
      <td>
        <p className="dimension-reason">{dimension.evidence.reason}</p>
        <details className="evidence-details">
          <summary>
            Evidence
            {findingCount === 0
              ? ''
              : ` and ${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}`}
          </summary>
          <dl className="evidence-grid">
            <div>
              <dt>Scope</dt>
              <dd>{dimension.evidence.scope}</dd>
            </div>
            {Object.entries(dimension.evidence.details).map(([key, value]) => (
              <div key={key}>
                <dt>
                  <code>{key}</code>
                </dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
          {dimension.findings.length === 0 ? null : (
            <ul className="finding-list">
              {dimension.findings.map((finding, index) => (
                <li key={`${finding.code}-${String(index)}`}>
                  <SeverityBadge severity={finding.severity} /> <code>{finding.code}</code>{' '}
                  {finding.message}
                  {finding.path === undefined ? null : (
                    <>
                      {' '}
                      at <code>{finding.path}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </td>
    </tr>
  )
}

function ResultMetadata({ result }: { readonly result: CredentialValidationResult }) {
  return (
    <dl className="metadata-grid">
      <div>
        <dt>Validation ID</dt>
        <dd>
          <code>{result.validationId}</code>
        </dd>
      </div>
      <div>
        <dt>Validated at</dt>
        <dd>
          <time dateTime={result.validatedAt}>{formatValidatedAt(result.validatedAt)}</time>
        </dd>
      </div>
      <div>
        <dt>Rulebook</dt>
        <dd>
          {result.rulebook.name} <span className="muted">({result.rulebook.id})</span>
        </dd>
      </div>
      <div>
        <dt>Pinned version</dt>
        <dd>
          <code>{result.rulebook.version}</code> <StatusBadge status={result.rulebook.status} />{' '}
          <span className="muted">{result.rulebook.specVersion}</span>
        </dd>
      </div>
      <div>
        <dt>Snapshot digest (SHA-256)</dt>
        <dd>
          <code className="digest" title={result.rulebook.digest}>
            {formatDigest(result.rulebook.digest)}
          </code>{' '}
          <span className="muted">
            {result.rulebook.digestVerified ? 'recomputed and verified' : 'not verified'}
          </span>
        </dd>
      </div>
      <div>
        <dt>Attestation type</dt>
        <dd>
          {result.attestation.name}{' '}
          <span className="muted">
            · {result.attestation.attestationLoS} · {result.attestation.bindingType}
          </span>
        </dd>
      </div>
      <div>
        <dt>Credential format</dt>
        <dd>
          {result.credential.format === null ? (
            <span className="muted">Not recognised</span>
          ) : (
            <code>{result.credential.format}</code>
          )}
        </dd>
      </div>
      <div>
        <dt>Credential type (vct)</dt>
        <dd>
          {result.credential.vct === null ? (
            <span className="muted">Not available</span>
          ) : (
            <code>{result.credential.vct}</code>
          )}
        </dd>
      </div>
      <div>
        <dt>Disclosures</dt>
        <dd>{result.credential.disclosureCount}</dd>
      </div>
      <div>
        <dt>Key binding present</dt>
        <dd>{result.credential.keyBindingPresent ? 'Yes' : 'No'}</dd>
      </div>
    </dl>
  )
}

function SchemaReferences({ result }: { readonly result: CredentialValidationResult }) {
  return (
    <section className="detail-card" aria-labelledby="validation-schema-heading">
      <h2 id="validation-schema-heading">Schema references</h2>
      {result.schemaReferences.length === 0 ? (
        <p className="muted">
          The pinned rulebook version records no schema reference for this attestation type and
          credential format.
        </p>
      ) : (
        <div className="table-wrap table-wrap--nested">
          <table className="detail-table">
            <caption className="sr-only">
              Schema references of the pinned rulebook version and whether this run applied them
            </caption>
            <thead>
              <tr>
                <th scope="col">Format</th>
                <th scope="col">Schema URI</th>
                <th scope="col">Integrity</th>
                <th scope="col">Kind</th>
                <th scope="col">Applied</th>
              </tr>
            </thead>
            <tbody>
              {result.schemaReferences.map((reference) => (
                <tr key={`${reference.formatIdentifier}-${reference.uri}`}>
                  <th scope="row" className="cell-format">
                    {reference.formatIdentifier}
                  </th>
                  <td>
                    <SafeUri uri={reference.uri} />
                  </td>
                  <td>
                    {reference.integrity === null ? (
                      <span className="muted">None recorded</span>
                    ) : (
                      <code title={reference.integrity}>{reference.integrity}</code>
                    )}
                  </td>
                  <td>
                    {reference.kind === null ? (
                      <span className="muted">Not classified</span>
                    ) : reference.kind === 'type_metadata' ? (
                      'Type Metadata'
                    ) : (
                      'JSON Schema'
                    )}
                  </td>
                  <td>{reference.applied ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="table-note">
        A schema is applied only when a caller-supplied document matches a pinned reference and its
        integrity pin verifies. This playground does not supply schema documents, so schema
        validation remains <strong>not tested</strong>.
      </p>
    </section>
  )
}

export function ValidationReport({
  result,
  onExport,
}: {
  readonly result: CredentialValidationResult
  readonly onExport: () => void
}) {
  const summary = validationSummary(result)
  return (
    <div className="validation-report">
      <section className="detail-card" aria-labelledby="validation-overall-heading">
        <div className="validation-overall">
          <div>
            <h2 id="validation-overall-heading">Overall result</h2>
            <p className="validation-overall__status">
              <ValidationStatusBadge status={result.overallStatus} />
              <span>{OVERALL_EXPLANATIONS[result.overallStatus]}</span>
            </p>
          </div>
          <button type="button" className="button button--primary" onClick={onExport}>
            Export result (JSON)
          </button>
        </div>
        <p className="table-note">
          This is a structural, non-cryptographic result. It never implies cryptographic, issuer
          trust, protocol or interoperability success.
        </p>
        <UntestedNotice summary={summary} />
        <ResultMetadata result={result} />
      </section>

      <section className="detail-card" aria-labelledby="validation-dimensions-heading">
        <h2 id="validation-dimensions-heading">Validation dimensions</h2>
        <p className="table-note">
          Every FR-010 dimension is listed in normative order with its status, whether it was
          applicable to this request, and whether an actual check ran. An unexecuted dimension is
          never a pass.
        </p>
        <div className="table-wrap table-wrap--nested">
          <table className="detail-table dimension-table">
            <caption className="sr-only">
              The eight validation dimensions with status, applicability, execution and evidence
            </caption>
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col">Status</th>
                <th scope="col">Execution</th>
                <th scope="col">Applicability</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {result.dimensions.map((dimension) => (
                <DimensionRow dimension={dimension} key={dimension.id} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="detail-card" aria-labelledby="validation-violations-heading">
        <h2 id="validation-violations-heading">Violations</h2>
        {result.violations.length === 0 ? (
          <p className="muted">
            No violations were reported. That does not mean every dimension passed: untested and
            not-applicable dimensions are listed above and in the limitations below.
          </p>
        ) : (
          <div className="table-wrap table-wrap--nested">
            <table className="detail-table violation-table">
              <caption className="sr-only">
                Individual violations with severity, dimension, code, path and expected constraint
              </caption>
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Dimension</th>
                  <th scope="col">Code</th>
                  <th scope="col">Path</th>
                  <th scope="col">Expected</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {result.violations.map((violation, index) => (
                  <tr key={`${violation.code}-${String(index)}`}>
                    <td>
                      <SeverityBadge severity={violation.severity} />
                    </td>
                    <td>{dimensionTitle(violation.dimension)}</td>
                    <th scope="row">
                      <code>{violation.code}</code>
                    </th>
                    <td>
                      {violation.path === undefined ? (
                        <span className="muted">None</span>
                      ) : (
                        <code>{violation.path}</code>
                      )}
                    </td>
                    <td>
                      {violation.expected === undefined ? (
                        <span className="muted">None</span>
                      ) : (
                        <span>{violation.expected}</span>
                      )}
                    </td>
                    <td>{violation.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="detail-card" aria-labelledby="validation-limitations-heading">
        <h2 id="validation-limitations-heading">Limitations of this result</h2>
        {result.limitations.length === 0 ? (
          <p className="muted">No limitations were reported for this run.</p>
        ) : (
          <ul className="limitation-list">
            {result.limitations.map((limitation, index) => (
              <li key={`${limitation.dimension}-${limitation.code}-${String(index)}`}>
                <span className="limitation-heading">
                  <ValidationStatusBadge status={limitation.status} />
                  <strong>{dimensionTitle(limitation.dimension)}</strong>
                  <code>{limitation.code}</code>
                </span>
                <p>{limitation.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SchemaReferences result={result} />

      <p className="table-note">
        Validated at {formatDate(result.validatedAt)} · exported reports contain the typed result
        only; the credential artifact and claim values are never included.
      </p>
    </div>
  )
}
