import { Buffer } from 'node:buffer'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from './database.js'
import {
  getDocumentProcessingSettings,
  updateDocumentProcessingSettings,
} from './document-processing.js'
import { decideIntake, stageIntake } from './intake.js'

afterAll(() => closeDb())

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

describe('document processing', () => {
  it('creates a durable completed job and derivative for native text', () => {
    const item = stageIntake({
      organizationId: 'org-default',
      filename: `memo-${Date.now()}.txt`,
      mediaType: 'text/plain',
      contentBase64: encoded(
        'This is a sufficiently long controlled test memorandum for native extraction.',
      ),
      submittedBy: 'test-member',
    })

    expect(item.processing).toMatchObject({ state: 'complete', extractionMethod: 'native-text' })
    expect(() =>
      decideIntake(item.id, 'org-1', {
        decision: 'release',
        classification: 'UNCLASSIFIED',
        tags: [],
        reviewedBy: 'reviewer',
      }),
    ).not.toThrow()
  })

  it('keeps image material staged when an OCR engine is required', () => {
    const item = stageIntake({
      organizationId: 'org-default',
      filename: `scan-${Date.now()}.png`,
      mediaType: 'image/png',
      contentBase64: encoded('not-a-real-image-fixture'),
      submittedBy: 'test-member',
    })

    expect(item.processing).toMatchObject({
      state: 'needs-input',
      errorCode: 'OCR_ENGINE_REQUIRED',
    })
    expect(() =>
      decideIntake(item.id, 'org-1', {
        decision: 'release',
        classification: 'UNCLASSIFIED',
        tags: [],
        reviewedBy: 'reviewer',
      }),
    ).toThrow('Document processing must complete before release')
  })

  it('persists validated organization settings', () => {
    const organizationId = `org-settings-${Date.now()}`
    const settings = updateDocumentProcessingSettings(
      organizationId,
      {
        maxFileSizeBytes: 40 * 1024 * 1024,
        ocrLanguages: ['eng', 'spa'],
        nativeTextMinimum: 64,
        jobTimeoutSeconds: 240,
      },
      'admin-1',
    )

    expect(settings).toMatchObject({
      ocrLanguages: ['eng', 'spa'],
      nativeTextMinimum: 64,
      jobTimeoutSeconds: 240,
    })
    expect(getDocumentProcessingSettings(organizationId)).toEqual(settings)
  })
})
