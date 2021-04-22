import * as multiparty from 'multiparty'
import getStream from 'get-stream'
import pump from 'pump'
import { createLogger } from '@xen-orchestra/log'
import { defer } from 'golike-defer'
import { format } from 'json-rpc-peer'
import { noSuchObject } from 'xo-common/api-errors'
import { peekFooterFromVhdStream } from 'vhd-lib'
import { vmdkToVhd } from 'xo-vmdk-to-vhd'

import { VDI_FORMAT_VHD } from '../xapi/index.js'

const log = createLogger('xo:disk')

// ===================================================================

export const create = defer(async function ($defer, { name, size, sr, vm, bootable, position, mode }) {
  const attach = vm !== undefined

  do {
    let resourceSet
    if (attach && (resourceSet = vm.resourceSet) != null) {
      try {
        await this.checkResourceSetConstraints(resourceSet, this.user.id, [sr.id])
        await this.allocateLimitsInResourceSet({ disk: size }, resourceSet)
        $defer.onFailure(() => this.releaseLimitsInResourceSet({ disk: size }, resourceSet))

        break
      } catch (error) {
        if (!noSuchObject.is(error, { id: resourceSet })) {
          throw error
        }
      }

      // the resource set does not exist, falls back to normal check
    }

    await this.checkPermissions(this.user.id, [[sr.id, 'administrate']])
  } while (false)

  const xapi = this.getXapi(sr)
  const vdi = await xapi.createVdi({
    name_label: name,
    size,
    sr: sr._xapiId,
  })
  $defer.onFailure(() => vdi.$destroy())

  if (attach) {
    await xapi.createVbd({
      bootable,
      mode,
      userdevice: position,
      vdi: vdi.$id,
      vm: vm._xapiId,
    })
  }

  return vdi.$id
})

create.description = 'create a new disk on a SR'

create.params = {
  name: { type: 'string' },
  size: { type: ['integer', 'string'] },
  sr: { type: 'string' },
  vm: { type: 'string', optional: true },
  bootable: { type: 'boolean', optional: true },
  mode: { type: 'string', optional: true },
  position: { type: 'string', optional: true },
}

create.resolve = {
  vm: ['vm', 'VM', 'administrate'],
  sr: ['sr', 'SR', false],
}

// -------------------------------------------------------------------

async function handleExportContent(req, res, { xapi, id }) {
  const stream = await xapi.exportVdiContent(id)
  req.on('close', () => stream.cancel())

  // Remove the filename as it is already part of the URL.
  stream.headers['content-disposition'] = 'attachment'

  res.writeHead(stream.statusCode, stream.statusMessage != null ? stream.statusMessage : '', stream.headers)
  pump(stream, res, error => {
    if (error != null) {
      log.warn('disk.exportContent', { error })
    }
  })
}

export async function exportContent({ vdi }) {
  return {
    $getFrom: await this.registerHttpRequest(
      handleExportContent,
      {
        id: vdi._xapiId,
        xapi: this.getXapi(vdi),
      },
      {
        suffix: `/${encodeURIComponent(vdi.name_label)}.vhd`,
      }
    ),
  }
}

exportContent.description = 'export the content of a VDI'
exportContent.params = {
  id: { type: 'string' },
}
exportContent.resolve = {
  vdi: ['id', ['VDI', 'VDI-snapshot'], 'view'],
}

// -------------------------------------------------------------------

async function handleImportContent(req, res, { xapi, id }) {
  // Timeout seems to be broken in Node 4.
  // See https://github.com/nodejs/node/issues/3319
  req.setTimeout(43200000) // 12 hours
  req.length = +req.headers['content-length']
  await xapi.importVdiContent(id, req)
  res.end(format.response(0, true))
}

export async function importContent({ vdi }) {
  return {
    $sendTo: await this.registerHttpRequest(handleImportContent, {
      id: vdi._xapiId,
      xapi: this.getXapi(vdi),
    }),
  }
}

importContent.description = 'import contents into a VDI'
importContent.params = {
  id: { type: 'string' },
}
importContent.resolve = {
  vdi: ['id', ['VDI'], 'operate'],
}

/**
 * here we expect to receive a POST in multipart/form-data
 * When importing a VMDK file:
 *  - The first parts are the tables in uint32 LE
 *    - grainLogicalAddressList : uint32 LE in VMDK blocks
 *    - grainFileOffsetList : uint32 LE in sectors, limits the biggest VMDK size to 2^41B (2^32 * 512B)
 *  - the last part is the vmdk file.
 */
async function handleImport(req, res, { type, name, description, vmdkData, srId, xapi }) {
  req.setTimeout(43200000) // 12 hours
  req.length = req.headers['content-length']
  let vhdStream, size
  await new Promise((resolve, reject) => {
    const promises = []
    const form = new multiparty.Form()
    form.on('error', reject)
    form.on('part', async part => {
      if (part.name !== 'file') {
        promises.push(
          (async () => {
            const view = new DataView((await getStream.buffer(part)).buffer)
            const result = new Uint32Array(view.byteLength / 4)
            for (const i in result) {
              result[i] = view.getUint32(i * 4, true)
            }
            vmdkData[part.name] = result
          })()
        )
      } else {
        await Promise.all(promises)
        part.length = part.byteCount
        if (type === 'vmdk') {
          vhdStream = await vmdkToVhd(part, vmdkData.grainLogicalAddressList, vmdkData.grainFileOffsetList)
          size = vmdkData.capacity
        } else if (type === 'vhd') {
          vhdStream = part
          const footer = await peekFooterFromVhdStream(vhdStream)
          size = footer.currentSize
        } else {
          throw new Error(`Unknown disk type, expected "vhd" or "vmdk", got ${type}`)
        }
        const vdi = await xapi.createVdi({
          name_description: description,
          name_label: name,
          size,
          sr: srId,
        })
        try {
          await xapi.importVdiContent(vdi, vhdStream, VDI_FORMAT_VHD)
          res.end(format.response(0, vdi.$id))
        } catch (e) {
          await vdi.$destroy()
          throw e
        }
        resolve()
      }
    })
    form.parse(req)
  })
}

// type is 'vhd' or 'vmdk'
async function importDisk({ sr, type, name, description, vmdkData }) {
  return {
    $sendTo: await this.registerHttpRequest(handleImport, {
      description,
      name,
      srId: sr._xapiId,
      type,
      vmdkData,
      xapi: this.getXapi(sr),
    }),
  }
}

export { importDisk as import }

importDisk.params = {
  description: { type: 'string', optional: true },
  name: { type: 'string' },
  sr: { type: 'string' },
  type: { type: 'string' },
  vmdkData: {
    type: 'object',
    optional: true,
    properties: {
      capacity: { type: 'integer' },
    },
  },
}
importDisk.resolve = {
  sr: ['sr', 'SR', 'administrate'],
}
