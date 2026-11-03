// Run: deno test supabase/functions/_shared/gemini_thinking_test.ts
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  alternateThinkingConfig,
  isThinkingConfigError,
  modelRequiresThinking,
  offThinkingConfig,
} from './gemini_thinking.ts'

// Each expectation is what the live API accepted on 2026-11-03 (see the table
// at the top of gemini_thinking.ts).
Deno.test('offThinkingConfig picks the form each model accepts', () => {
  assertEquals(offThinkingConfig('gemini-2.5-flash'), { thinkingBudget: 0 })
  assertEquals(offThinkingConfig('gemini-2.5-flash-lite'), { thinkingBudget: 0 })
  assertEquals(offThinkingConfig('gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' })
  assertEquals(offThinkingConfig('gemini-3.1-flash-lite'), { thinkingLevel: 'minimal' })
  assertEquals(offThinkingConfig('gemini-3.6-flash'), { thinkingBudget: 0 })
  assertEquals(offThinkingConfig('gemini-3.8-flash'), { thinkingBudget: 0 })
  assertEquals(offThinkingConfig('gemini-3.1-pro-preview'), null)
  assertEquals(offThinkingConfig('gemini-2.5-pro'), null)
})

Deno.test('modelRequiresThinking matches the pro tier only', () => {
  assertEquals(modelRequiresThinking('gemini-3.1-pro-preview'), true)
  assertEquals(modelRequiresThinking('gemini-pro-latest'), true)
  assertEquals(modelRequiresThinking('gemini-3.5-flash-lite'), false)
  assertEquals(modelRequiresThinking('gemini-3.8-flash'), false)
})

Deno.test('alternateThinkingConfig swaps budget and level', () => {
  assertEquals(alternateThinkingConfig({ thinkingBudget: 0 }), { thinkingLevel: 'minimal' })
  assertEquals(alternateThinkingConfig({ thinkingLevel: 'minimal' }), { thinkingBudget: 0 })
})

Deno.test('isThinkingConfigError recognises the messages Gemini actually returns', () => {
  assertEquals(isThinkingConfigError(400, 'Request contains an invalid argument.'), true)
  assertEquals(isThinkingConfigError(400, 'Thinking level MINIMAL is not supported for this model.'), true)
  assertEquals(isThinkingConfigError(400, 'Budget 0 is invalid. This model only works in thinking mode.'), true)
  assertEquals(isThinkingConfigError(400, 'API key not valid'), false)
  assertEquals(isThinkingConfigError(429, 'Request contains an invalid argument.'), false)
})
