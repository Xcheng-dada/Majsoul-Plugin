import protobuf from 'protobufjs'
import path from 'path'
import fs from 'fs'

const configDir = path.resolve('./plugins/Majsoul-Plugin/config')
const liqiPath = path.join(configDir, 'liqi.json')
const liqiMetaPath = path.join(configDir, 'liqi.version.json')

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

class MajsoulProtoCodec {
  constructor() {
    this.NOTIFY = 1
    this.REQUEST = 2
    this.RESPONSE = 3
    this.index = 1
    this.inflightRequests = new Map()
    this.root = null
    this.wrapper = null
    this.version = null
  }

  async init(urlBase = 'https://game.maj-soul.com/', expectedVersion = null) {
    if (this.root && (!expectedVersion || this.version === expectedVersion)) return

    const meta = readJsonIfExists(liqiMetaPath)
    const shouldDownload = !fs.existsSync(liqiPath) || (expectedVersion && meta?.version !== expectedVersion)

    if (shouldDownload) {
      if (typeof logger !== 'undefined') {
        const reason = fs.existsSync(liqiPath) ? `本地协议版本 ${meta?.version || 'unknown'} != ${expectedVersion}` : 'liqi.json 不存在'
        logger.info(`[Majsoul-Plugin] ${reason}，正在从官方服务器更新协议...`)
      }

      try {
        let myFetch = global.fetch
        if (!myFetch) {
          myFetch = (await import('node-fetch')).default
        }
        const fetchOptions = {}

        let version = expectedVersion
        if (!version) {
          const r1 = await myFetch(`${urlBase}1/version.json?randv=${Math.random()}`, fetchOptions)
          const v = await r1.json()
          version = v.version
        }

        const r2 = await myFetch(`${urlBase}1/resversion${version}.json`, fetchOptions)
        const res = await r2.json()
        const prefix = res.res['res/proto/liqi.json'].prefix
        const r3 = await myFetch(`${urlBase}1/${prefix}/res/proto/liqi.json`, fetchOptions)
        const liqiText = await r3.text()
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(liqiPath, liqiText)
        fs.writeFileSync(liqiMetaPath, JSON.stringify({
          version,
          prefix,
          updated_at: new Date().toISOString()
        }, null, 2))
        if (typeof logger !== 'undefined') logger.info(`[Majsoul-Plugin] liqi.json 更新完成 (${version})`)
      } catch (err) {
        if (!fs.existsSync(liqiPath)) {
          throw new Error(`[Majsoul-Plugin] 自动下载 liqi.json 失败: ${err.message}`)
        }
        if (typeof logger !== 'undefined') {
          logger.warn(`[Majsoul-Plugin] 更新 liqi.json 失败，继续使用本地缓存: ${err.message}`)
        }
      }
    }

    if (fs.existsSync(liqiPath)) {
      this.root = await protobuf.load(liqiPath)
      this.wrapper = this.root.lookupType('lq.Wrapper')
      this.version = expectedVersion || readJsonIfExists(liqiMetaPath)?.version || null
    } else {
      throw new Error(`[Majsoul-Plugin] 找不到 ${liqiPath}，请确保资源已更新！`)
    }
  }

  resetCodecState() {
    this.index = 1
    this.inflightRequests.clear()
  }

  unwrap(wrappedData) {
    const message = this.wrapper.decode(wrappedData)
    return message
  }

  wrap(name, dataBuffer) {
    const message = this.wrapper.create({ name: name, data: dataBuffer })
    return this.wrapper.encode(message).finish()
  }

  lookupMethod(path) {
    return this.root.lookupType(path)
  }

  decodeMessage(buf) {
    const typeByte = buf[0]
    let reqIndex, msg, methodName, msgObj, payload

    if (typeByte === this.NOTIFY) {
      reqIndex = this.index
      msg = this.unwrap(buf.slice(1))
      methodName = msg.name
      const parts = methodName.split('.')
      const notifyName = parts[parts.length - 1]
      msgObj = this.lookupMethod(`lq.${notifyName}`)
      payload = msgObj.decode(msg.data)
    } else if (typeByte === this.REQUEST) {
      reqIndex = buf[1] | (buf[2] << 8)
      msg = this.unwrap(buf.slice(3))
      methodName = msg.name
      const parts = methodName.split('.')
      const service = parts[2]
      const rpc = parts[3]

      const protoService = this.root.lookupService(`lq.${service}`)
      const protoMethod = protoService.methods[rpc]
      msgObj = this.lookupMethod(protoMethod.requestType)
      payload = msgObj.decode(msg.data)
    } else if (typeByte === this.RESPONSE) {
      reqIndex = buf[1] | (buf[2] << 8)
      msg = this.unwrap(buf.slice(3))
      const inflightReq = this.inflightRequests.get(reqIndex)
      if (!inflightReq) {
        throw new Error(`Unknown request index: ${reqIndex}`)
      }
      this.inflightRequests.delete(reqIndex)
      msgObj = inflightReq.responseType
      methodName = inflightReq.methodName

      if (msg.data && msg.data.length > 0) {
        payload = msgObj.decode(msg.data)
      } else {
        payload = {}
      }
    } else {
      throw new Error(`Invalid message type: ${typeByte}`)
    }

    return {
      msgType: typeByte,
      reqIndex,
      methodName,
      payload: msgObj.toObject(payload, { enums: String, defaults: true })
    }
  }

  encodeRequest(methodName, payloadDict) {
    const currentIndex = this.index++
    const parts = methodName.split('.')
    const service = parts[2]
    const rpc = parts[3]

    const protoService = this.root.lookupService(`lq.${service}`)
    if (!protoService || !protoService.methods[rpc]) {
      throw new Error(`Unknown method ${rpc}`)
    }
    const protoMethod = protoService.methods[rpc]

    const RequestType = this.lookupMethod(protoMethod.requestType)
    const ResponseType = this.lookupMethod(protoMethod.responseType)

    const errMsg = RequestType.verify(payloadDict)
    if (errMsg) throw new Error(errMsg)

    const message = RequestType.create(payloadDict)
    const buffer = RequestType.encode(message).finish()

    const wrappedBuf = this.wrap(methodName, buffer)

    this.inflightRequests.set(currentIndex, {
      methodName,
      responseType: ResponseType
    })

    const header = Buffer.alloc(3)
    header.writeUInt8(this.REQUEST, 0)
    header.writeUInt16LE(currentIndex, 1)

    return Buffer.concat([header, wrappedBuf])
  }
}

export default new MajsoulProtoCodec()
