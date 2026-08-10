import {
  type UswdsWireframeArtifact,
  type UswdsWireframeSection,
  isUswdsWireframeArtifact,
} from '@papyrus/core/artifacts/uswds-wireframe'
import { Search } from 'lucide-react'
import type { CSSProperties } from 'react'

interface UswdsWireframePreviewProps {
  artifact: unknown
  compact?: boolean
}

function Section({ section }: { section: UswdsWireframeSection }) {
  switch (section.kind) {
    case 'banner':
      return <div className="uswds-preview-banner">🇺🇸 {section.text}</div>
    case 'header':
      return (
        <header className="uswds-preview-header">
          <div>
            <small>{section.agency}</small>
            <strong>{section.title}</strong>
          </div>
          {!!section.navigation?.length && (
            <nav aria-label="Wireframe navigation">
              {section.navigation.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </nav>
          )}
        </header>
      )
    case 'hero':
      return (
        <section className="uswds-preview-hero">
          {section.eyebrow && <small>{section.eyebrow}</small>}
          <h3>{section.heading}</h3>
          <p>{section.body}</p>
          <div className="uswds-preview-actions">
            {section.primaryAction && <button type="button">{section.primaryAction}</button>}
            {section.secondaryAction && <button type="button">{section.secondaryAction}</button>}
          </div>
        </section>
      )
    case 'search':
      return (
        <section className="uswds-preview-search">
          <label>
            {section.label}
            <div>
              <input type="text" readOnly placeholder={section.placeholder} />
              <button type="button" aria-label={section.buttonLabel ?? 'Search'}>
                <Search size={14} aria-hidden="true" /> {section.buttonLabel ?? 'Search'}
              </button>
            </div>
          </label>
        </section>
      )
    case 'card-grid':
      return (
        <section className="uswds-preview-section">
          {section.heading && <h4>{section.heading}</h4>}
          <div className="uswds-preview-cards">
            {section.cards.map((card) => (
              <article key={`${card.title}-${card.body}`}>
                {card.meta && <small>{card.meta}</small>}
                <h5>{card.title}</h5>
                <p>{card.body}</p>
                {card.action && <a href="#wireframe">{card.action} →</a>}
              </article>
            ))}
          </div>
        </section>
      )
    case 'summary-box':
      return (
        <section className="uswds-preview-summary">
          <h4>{section.heading}</h4>
          <p>{section.body}</p>
          {!!section.items?.length && (
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      )
    case 'table':
      return (
        <section className="uswds-preview-section">
          <table>
            {section.caption && <caption>{section.caption}</caption>}
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.join('::')}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${section.columns[cellIndex]}-${cell}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )
    case 'form':
      return (
        <section className="uswds-preview-section uswds-preview-form">
          {section.heading && <h4>{section.heading}</h4>}
          {section.fields.map((field) => (
            <div className="uswds-preview-field" key={`${field.label}-${field.type}`}>
              {field.type === 'checkbox' ? (
                <label>
                  <input type="checkbox" readOnly /> {field.label}
                </label>
              ) : (
                <>
                  <span>{field.label}</span>
                  {field.type === 'textarea' ? (
                    <textarea readOnly aria-label={field.label} />
                  ) : field.type === 'select' ? (
                    <select defaultValue="" aria-label={field.label}>
                      <option value="" disabled>
                        Select
                      </option>
                      {field.options?.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input type="text" readOnly aria-label={field.label} />
                  )}
                </>
              )}
            </div>
          ))}
          <button type="button">{section.submitLabel}</button>
        </section>
      )
    case 'footer':
      return (
        <footer className="uswds-preview-footer">
          <strong>{section.agency}</strong>
          <div>{section.links?.join(' · ')}</div>
        </footer>
      )
  }
}

export function UswdsWireframePreview({ artifact, compact = false }: UswdsWireframePreviewProps) {
  if (!isUswdsWireframeArtifact(artifact)) return null
  const wireframe: UswdsWireframeArtifact = artifact
  const themeStyle = {
    '--uswds-preview-primary': wireframe.theme?.primaryColor ?? '#005ea8',
    '--uswds-preview-accent': wireframe.theme?.accentColor ?? '#00bde3',
  } as CSSProperties
  return (
    <div
      className={`uswds-wireframe-preview ${compact ? 'compact' : ''} viewport-${wireframe.viewport}`}
      aria-label={`${wireframe.title} wireframe preview`}
      style={themeStyle}
    >
      <div className="uswds-preview-browser-bar">
        <span /> <span /> <span />
        <strong>{wireframe.title}</strong>
        <em>USWDS</em>
      </div>
      <div className="uswds-preview-page">
        {wireframe.sections.map((section, index) => (
          <Section key={`${section.kind}-${index}`} section={section} />
        ))}
      </div>
    </div>
  )
}
