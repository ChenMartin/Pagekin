import { crc32, deflateRawSync } from 'node:zlib'

export function sampleEpub({ encrypted = false, expansion = false } = {}) {
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><!-- <rootfile full-path="broken.opf"/> --><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    'OEBPS/book.opf': `<package><manifest>
      <item id="last" href="Text/%E6%97%A0%E7%BC%96%E5%8F%B7.xhtml" media-type="application/xhtml+xml"/>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="first" href="Text/first.xhtml" media-type="application/xhtml+xml"/>
      </manifest><spine><!-- <itemref idref="wrong"/> --><itemref idref="nav"/><itemref idref="first"/><itemref idref="last"/></spine></package>`,
    'OEBPS/nav.xhtml': '<html><body><p>目录文字不导入</p></body></html>',
    'OEBPS/Text/无编号.xhtml': '<html><head><title>海上番外</title></head><body><p>没有章号的正文。</p></body></html>',
    'OEBPS/Text/first.xhtml': expansion ? 'x'.repeat(12_000_001) : `<html><body>
      <p>开篇引子。</p><h1>第二章 风起</h1><p>远处的灯塔&amp;船。</p>
      <script>隐藏脚本内容</script><style>不导入样式</style>
      <h2>Chapter 3: Return</h2><p>夜里回港。</p></body></html>`,
  }
  if (encrypted) files['META-INF/encryption.xml'] = '<encryption><EncryptedData><EncryptionMethod Algorithm="urn:protected"/><CipherReference URI="OEBPS/Text/first.xhtml"/></EncryptedData></encryption>'
  const local = []
  const central = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path)
    const data = Buffer.from(content)
    const method = path === 'mimetype' ? 0 : 8
    const compressed = method ? deflateRawSync(data) : data
    const entry = Buffer.alloc(30)
    entry.writeUInt32LE(0x04034b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(0x0800, 6)
    entry.writeUInt16LE(method, 8)
    entry.writeUInt32LE(crc32(data), 14)
    entry.writeUInt32LE(compressed.length, 18)
    entry.writeUInt32LE(data.length, 22)
    entry.writeUInt16LE(name.length, 26)
    local.push(entry, name, compressed)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50)
    index.writeUInt16LE(20, 4)
    entry.copy(index, 6, 4, 30)
    index.writeUInt32LE(offset, 42)
    central.push(index, name)
    offset += entry.length + name.length + compressed.length
  }
  const index = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(central.length / 2, 8)
  end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, index, end])
}
