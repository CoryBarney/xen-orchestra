'use strict'

/* eslint-env jest */

const rimraf = require('rimraf')
const tmp = require('tmp')
const { Disposable, pFromCallback } = require('promise-toolbox')
const { getSyncedHandler } = require('@xen-orchestra/fs')

const { SECTOR_SIZE, PLATFORMS } = require('../_constants')
const { createRandomFile, convertFromRawToVhd } = require('../tests/utils')
const { openVhd, chainVhd } = require('..')
const { VhdSynthetic } = require('./VhdSynthetic')

let tempDir = null

jest.setTimeout(60000)

beforeEach(async () => {
  tempDir = await pFromCallback(cb => tmp.dir(cb))
})

afterEach(async () => {
  await pFromCallback(cb => rimraf(tempDir, cb))
})

test('It can read block and parent locator from a synthetic vhd', async () => {
  const bigRawFileName = `/bigrandomfile`
  await createRandomFile(`${tempDir}/${bigRawFileName}`, 8)
  const bigVhdFileName = `/bigrandomfile.vhd`
  await convertFromRawToVhd(`${tempDir}/${bigRawFileName}`, `${tempDir}/${bigVhdFileName}`)

  const smallRawFileName = `/smallrandomfile`
  await createRandomFile(`${tempDir}/${smallRawFileName}`, 4)
  const smallVhdFileName = `/smallrandomfile.vhd`
  await convertFromRawToVhd(`${tempDir}/${smallRawFileName}`, `${tempDir}/${smallVhdFileName}`)

  await Disposable.use(async function* () {
    const handler = yield getSyncedHandler({ url: `file://${tempDir}` })
    // ensure the two VHD are linked, with the child of type DISK_TYPES.DIFFERENCING
    await chainVhd(handler, bigVhdFileName, handler, smallVhdFileName, true)

    const [smallVhd, bigVhd] = yield Disposable.all([
      openVhd(handler, smallVhdFileName),
      openVhd(handler, bigVhdFileName),
    ])
    // add parent locato
    // this will also scramble the block inside the vhd files
    await bigVhd.writeParentLocator({
      id: 0,
      platformCode: PLATFORMS.W2KU,
      data: Buffer.from('I am in the big one'),
    })
    const syntheticVhd = new VhdSynthetic([smallVhd, bigVhd])
    await syntheticVhd.readBlockAllocationTable()

    expect(syntheticVhd.header.diskType).toEqual(bigVhd.header.diskType)
    expect(syntheticVhd.header.parentTimestamp).toEqual(bigVhd.header.parentTimestamp)

    // first two block should be from small
    const buf = Buffer.alloc(syntheticVhd.sectorsPerBlock * SECTOR_SIZE, 0)
    let content = (await syntheticVhd.readBlock(0)).data
    await handler.read(smallRawFileName, buf, 0)
    expect(content).toEqual(buf)

    content = (await syntheticVhd.readBlock(1)).data
    await handler.read(smallRawFileName, buf, buf.length)
    expect(content).toEqual(buf)

    // the next one from big

    content = (await syntheticVhd.readBlock(2)).data
    await handler.read(bigRawFileName, buf, buf.length * 2)
    expect(content).toEqual(buf)

    content = (await syntheticVhd.readBlock(3)).data
    await handler.read(bigRawFileName, buf, buf.length * 3)
    expect(content).toEqual(buf)

    // the parent locator should the one of the root vhd
    const parentLocator = await syntheticVhd.readParentLocator(0)
    expect(parentLocator.platformCode).toEqual(PLATFORMS.W2KU)
    expect(Buffer.from(parentLocator.data, 'utf-8').toString()).toEqual('I am in the big one')
  })
})
