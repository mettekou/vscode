import v8 from 'node:v8'
import { register } from 'node:module'
import { dirname } from 'pathe'
import { setupFilePath } from '../constants'
import { createWorkerRPC } from './rpc'
import type { WorkerMeta, WorkerRunnerOptions } from './types'
import { VSCodeReporter } from './reporter'

async function initVitest(meta: WorkerMeta) {
  const vitestMode = await import(meta.vitestNodePath) as typeof import('vitest/node')
  const reporter = new VSCodeReporter()
  const vitest = await vitestMode.createVitest(
    'test',
    {
      config: meta.configFile,
      workspace: meta.workspaceFile,
      watch: true,
      api: false,
      root: dirname(meta.id),
      reporters: [reporter],
      ui: false,
      includeTaskLocation: true,
    },
    {
      server: {
        middlewareMode: true,
      },
      plugins: [
        {
          name: 'vitest:vscode-extension',
          configResolved(config) {
            // stub a server so Vite doesn't start a websocket connection,
            // because we don't need it in the extension and it messes up Vite dev command
            config.server.hmr = {
              server: {
                on: () => {},
                off: () => {},
              } as any,
            }
            if (!config.server.fs.allow.includes(setupFilePath))
              config.server.fs.allow.push(setupFilePath)
          },
        },
      ],
    },
  )
  reporter.initVitest(vitest, meta.id)
  return {
    vitest,
    reporter,
    meta,
  }
}

const cwd = process.cwd()

process.on('message', async function init(message: any) {
  if (message.type === 'init') {
    process.off('message', init)
    const data = message as WorkerRunnerOptions

    try {
      if (data.loader)
        register(data.loader)
      const errors = []

      const vitest = []
      for (const meta of data.meta) {
        process.chdir(dirname(meta.id))
        try {
          vitest.push(await initVitest(meta))
        }
        catch (err: any) {
          errors.push([meta.id, err.stack])
        }
      }
      process.chdir(cwd)

      if (!vitest.length) {
        process.send!({ type: 'error', errors })
        return
      }

      const vitestById = Object.fromEntries(vitest.map(v => [v.meta.id, v.vitest]))
      const rpc = createWorkerRPC(vitestById, {
        on(listener) {
          process.on('message', listener)
        },
        post(message) {
          process.send!(message)
        },
        serialize: v8.serialize,
        deserialize: v => v8.deserialize(Buffer.from(v)),
      })
      vitest.forEach(v => v.reporter.initRpc(rpc))
      process.send!({ type: 'ready', errors })
    }
    catch (err: any) {
      error(err)
    }
  }
})

function error(err: any) {
  process.send!({
    type: 'error',
    errors: ['', String(err.stack)],
  })
}

function _debug(...args: any[]) {
  process.send!({
    type: 'debug',
    args,
  })
}
