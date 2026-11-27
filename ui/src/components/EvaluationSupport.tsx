import { EVALUATION_SUPPORT, EVALUATION_SUPPORT_LABELS } from '../compatibility'

/**
 * What the validation engine can check for one credential, per FR-010
 * dimension. It describes this build, not any rulebook, so it lives on the
 * playground that runs those checks.
 */
export function EvaluationSupportSection() {
  return (
    <section className="content-section" aria-labelledby="evaluation-support-heading">
      <h2 id="evaluation-support-heading">What this playground checks</h2>
      <p>
        Every run validates one credential against a pinned rulebook version and reports all eight
        evaluation dimensions. This build executes only the dimensions marked supported.
      </p>
      <div className="table-wrap table-wrap--nested">
        <table className="detail-table">
          <caption className="sr-only">
            Evaluation dimensions and whether this build supports them for a credential
          </caption>
          <thead>
            <tr>
              <th scope="col">Evaluation dimension</th>
              <th scope="col">Support in this build</th>
            </tr>
          </thead>
          <tbody>
            {EVALUATION_SUPPORT.map((dimension) => (
              <tr key={dimension.id}>
                <th scope="row">{dimension.title}</th>
                <td>
                  <span className={`support support--${dimension.support}`}>
                    {EVALUATION_SUPPORT_LABELS[dimension.support]}
                  </span>
                  <span className="support-detail"> {dimension.detail}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="table-note">
        Not tested means the check did not run; not applicable means the dimension cannot be
        evaluated for a standalone credential. Neither status is a pass.
      </p>
    </section>
  )
}
