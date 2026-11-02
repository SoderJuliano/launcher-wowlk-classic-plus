'use strict'
// Manual E2E: installs a REAL client package (path in argv[2]) into a temp data dir.
// node tests/manual/real-package.cjs <zip> <dataDir>
const path = require('node:path')
const fs = require('node:fs')
const { ConfigurationManager } = require('../../electron/core/ConfigurationManager.cjs')
const { InstallationManager } = require('../../electron/core/InstallationManager.cjs')
const { readRealmlist } = require('../../electron/core/realmlist.cjs')
const log = require('../../electron/core/logger.cjs')

;(async () => {
  const [zip, dataDir] = process.argv.slice(2)
  log.init(path.join(dataDir, 'logs'))
  const config = new ConfigurationManager({ defaultsFile: path.join(__dirname, '../../config/defaults.json'), dataDir })
  const installer = new InstallationManager({ config })
  const t0 = Date.now()
  let last = 0
  const state = await installer.installFromZip({
    id: 'wow32', zipPath: zip,
    onProgress: (p) => { if (Date.now() - last > 15000) { last = Date.now(); console.log(`${p.phase} ${(p.done / 1e9).toFixed(1)}/${(p.total / 1e9).toFixed(1)} GB`) } }
  })
  const dir = config.clientDir('wow32')
  console.log('installed in', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(state))
  console.log('verify:', JSON.stringify(installer.verify('wow32')))
  console.log('realmlist enUS:', readRealmlist(dir, 'enUS'))
  console.log('Data/realmlist.wtf:', JSON.stringify(fs.readFileSync(path.join(dir, 'Data/realmlist.wtf'), 'latin1')))
  console.log('Config.wtf realm lines:', fs.readFileSync(path.join(dir, 'WTF/Config.wtf'), 'latin1').split(/\r?\n/).filter((l) => /realm|locale/i.test(l)))
})().catch((e) => { console.error('FAILED', e.code, e.message); process.exit(1) })
