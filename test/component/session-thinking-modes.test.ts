import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

test('PiAcpAgent: initialize advertises embeddedContext', async () => {
  const agent = new PiAcpAgent(new FakeConn() as any)
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal(res.agentCapabilities?.promptCapabilities?.embeddedContext, true)
})

test('PiAcpAgent: setSessionConfigOption maps thought_level to pi setThinkingLevel + emits config update', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)
  const proc = new FakePiRpcProcess() as any

  let setLevel: string | null = null
  proc.setThinkingLevel = async (level: string) => {
    setLevel = level
  }
  proc.getState = async () => ({
    thinkingLevel: setLevel ?? 'high',
    model: { provider: 'test', id: 'model' },
    sessionName: 'Config Session'
  })

  ;(agent as any).sessions = {
    get: () => ({ sessionId: 's1', proc })
  }

  const res = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'high'
  } as any)

  assert.equal(setLevel, 'high')

  const thought = res.configOptions.find((o: any) => o.id === 'thought_level')
  assert.ok(thought)
  assert.equal(thought?.category, 'thought_level')
  assert.equal(thought?.currentValue, 'high')

  const configUpdate = conn.updates.find((u: any) => u.update?.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)

  const modeUpdate = conn.updates.find((u: any) => u.update?.sessionUpdate === 'current_mode_update')
  assert.equal(modeUpdate?.update?.currentModeId, 'high')
})

test('PiAcpAgent: model config options are grouped by provider category', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)
  const proc = new FakePiRpcProcess() as any

  let currentModel = { provider: 'anthropic', id: 'claude-sonnet-4' }
  let setModelArgs: { provider: string; modelId: string } | null = null

  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4', contextWindow: 200000, reasoning: true },
      { provider: 'openai', id: 'gpt-4.1', contextWindow: 128000, reasoning: false }
    ]
  })
  proc.getState = async () => ({
    thinkingLevel: 'medium',
    model: currentModel,
    sessionName: 'Config Session'
  })
  proc.setModel = async (provider: string, modelId: string) => {
    setModelArgs = { provider, modelId }
    currentModel = { provider, id: modelId }
  }

  ;(agent as any).sessions = {
    get: () => ({ sessionId: 's1', proc })
  }

  const res = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'openai/gpt-4.1'
  } as any)

  assert.deepEqual(setModelArgs, { provider: 'openai', modelId: 'gpt-4.1' })

  const model = res.configOptions.find((o: any) => o.id === 'model')
  assert.ok(model)
  assert.equal(model?.category, 'model')
  assert.equal(model?.currentValue, 'openai/gpt-4.1')
  assert.deepEqual(model?.options, [
    {
      group: 'anthropic',
      name: 'anthropic',
      options: [
        {
          value: 'anthropic/claude-sonnet-4',
          name: 'claude-sonnet-4',
          description: '200,000 token context • reasoning'
        }
      ]
    },
    {
      group: 'openai',
      name: 'openai',
      options: [
        {
          value: 'openai/gpt-4.1',
          name: 'gpt-4.1',
          description: '128,000 token context'
        }
      ]
    }
  ])
})

test('PiAcpAgent: setSessionMode still rejects unknown mode IDs', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  await assert.rejects(() => agent.setSessionMode({ sessionId: 'nope', modeId: 'invalid' } as any), /invalid params/i)
})
