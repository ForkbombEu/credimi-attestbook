// Lifecycle transition policy tests (issue #41).
//
// Published artifacts stay immutable: only draft -> published and the internal
// published -> historical supersede are allowed for a version, and a rulebook
// working copy only moves between draft and published.

import { describe, expect, test } from 'bun:test'

import { isRegistryError } from './errors'
import {
  assertRulebookTransition,
  assertVersionTransition,
  isRulebookTransitionAllowed,
  isVersionTransitionAllowed,
  RULEBOOK_STATUS_TRANSITIONS,
  VERSION_STATUS_TRANSITIONS,
} from './transitions'

describe('version transition policy', () => {
  test('allows only draft -> published and published -> historical', () => {
    expect(VERSION_STATUS_TRANSITIONS.draft).toEqual(['published'])
    expect(VERSION_STATUS_TRANSITIONS.published).toEqual(['historical'])
    expect(VERSION_STATUS_TRANSITIONS.historical).toEqual([])

    expect(isVersionTransitionAllowed('draft', 'published')).toBe(true)
    expect(isVersionTransitionAllowed('published', 'historical')).toBe(true)
    expect(isVersionTransitionAllowed('published', 'draft')).toBe(false)
    expect(isVersionTransitionAllowed('historical', 'published')).toBe(false)
    expect(isVersionTransitionAllowed('draft', 'historical')).toBe(false)
    expect(isVersionTransitionAllowed('draft', 'draft')).toBe(false)
  })

  test('throws a typed immutable error for an invalid transition', () => {
    expect(() => assertVersionTransition('historical', 'published')).toThrow(/not allowed/)
    let caught: unknown
    try {
      assertVersionTransition('published', 'published')
    } catch (error) {
      caught = error
    }
    expect(isRegistryError(caught) ? caught.code : undefined).toBe('immutable')
  })

  test('accepts the allowed transitions without throwing', () => {
    expect(() => assertVersionTransition('draft', 'published')).not.toThrow()
    expect(() => assertVersionTransition('published', 'historical')).not.toThrow()
  })
})

describe('rulebook transition policy', () => {
  test('reopens a published working copy for the next draft', () => {
    expect(RULEBOOK_STATUS_TRANSITIONS.published).toEqual(['draft'])
    expect(isRulebookTransitionAllowed('published', 'draft')).toBe(true)
    expect(isRulebookTransitionAllowed('draft', 'published')).toBe(true)
    expect(isRulebookTransitionAllowed('historical', 'draft')).toBe(false)
  })

  test('rejects transitions out of historical', () => {
    expect(() => assertRulebookTransition('historical', 'published')).toThrow(/not allowed/)
  })
})
