// M4 genuine component owner. No normal startup binding or media send is added.
const MediaImageProcessor = ((io, nodePath, cryptoApi, childProcess, proc) => {
  const VERSION = 'm4-image-components-v3-linear-support-unscored';
  const SCRIPT = "\"\"\"One private in-memory image job using the already frozen Full components.\n\nNo filenames, network, cloud services, installation, or source discovery protocol.\nRecognition confidence remains UNKNOWN: successful OCR is not an egress grant.\n\"\"\"\nimport asyncio\nimport hashlib\nimport io\nimport json\nimport math\nimport struct\nimport sys\n\nVERSION = \"m4-image-components-v3-linear-support-unscored\"\nMAX_SOURCE = 8 * 1024 * 1024\nMAX_PIXELS = 8_000_000\nMAX_TEXT = 1024 * 1024\nMAX_WORDS = 20_000\nMAX_CODES = 4096\nMAX_META = 2 * 1024 * 1024\n\n\ndef exact_read(size):\n    data = bytearray()\n    while len(data) < size:\n        chunk = sys.stdin.buffer.read(size - len(data))\n        if not chunk:\n            raise ValueError(\"input_incomplete\")\n        data.extend(chunk)\n    return data\n\n\ndef canonical(data):\n    # Same Pillow/ImageOps mechanism as the reviewed M1 worker, extended to\n    # return RGBA and the original EXIF transform rather than copy metadata.\n    from PIL import Image, ImageOps\n    image = Image.open(io.BytesIO(data))\n    if image.format not in (\"PNG\", \"JPEG\", \"WEBP\", \"BMP\"):\n        raise ValueError(\"format_unsupported\")\n    width, height = image.size\n    if width < 1 or height < 1 or width * height > MAX_PIXELS:\n        raise ValueError(\"pixel_limit\")\n    if getattr(image, \"n_frames\", 1) != 1:\n        raise ValueError(\"animation_unsupported\")\n    orientation = image.getexif().get(274, 1)\n    if type(orientation) is not int or orientation not in range(1, 9):\n        raise ValueError(\"orientation_invalid\")\n    image.load()\n    rgba = ImageOps.exif_transpose(image).convert(\"RGBA\")\n    expected = (height, width) if orientation > 4 else (width, height)\n    if rgba.size != expected:\n        raise ValueError(\"orientation_invalid\")\n    white = Image.new(\"RGBA\", rgba.size, (255, 255, 255, 255))\n    rgb = Image.alpha_composite(white, rgba).convert(\"RGB\")\n    normalized = io.BytesIO()\n    # Fresh RGB object: neither OCR nor code detection sees hidden alpha RGB,\n    # source metadata, thumbnails, or source ancillary chunks.\n    fresh = Image.new(\"RGB\", rgb.size)\n    fresh.paste(rgb)\n    fresh.save(normalized, \"PNG\")\n    return rgba, rgb, normalized.getvalue(), {\"width\": width, \"height\": height, \"orientation\": orientation}\n\n\nasync def recognize(data, language, width, height):\n    # The reviewed M1 in-memory Windows.Media.Ocr transport, with explicit\n    # language and resource disposal. There is no English fallback.\n    from winsdk.windows.media.ocr import OcrEngine\n    from winsdk.windows.globalization import Language\n    from winsdk.windows.graphics.imaging import BitmapDecoder\n    from winsdk.windows.storage.streams import InMemoryRandomAccessStream, DataWriter\n    engine = OcrEngine.try_create_from_language(Language(language))\n    if engine is None:\n        raise ValueError(\"ocr_language_missing\")\n    if width > OcrEngine.max_image_dimension or height > OcrEngine.max_image_dimension:\n        raise ValueError(\"ocr_dimension_unsupported\")\n    stream = InMemoryRandomAccessStream()\n    writer = DataWriter(stream.get_output_stream_at(0))\n    bitmap = None\n    try:\n        writer.write_bytes(data)\n        await writer.store_async()\n        await writer.flush_async()\n        writer.detach_stream()\n        stream.seek(0)\n        decoder = await BitmapDecoder.create_async(stream)\n        bitmap = await decoder.get_software_bitmap_async()\n        result = await engine.recognize_async(bitmap)\n        words = []\n        for line_id, line in enumerate(result.lines):\n            for word in line.words:\n                r = word.bounding_rect\n                words.append({\"text\": word.text, \"line\": line_id,\n                              \"box\": [math.floor(r.x), math.floor(r.y), math.ceil(r.x + r.width), math.ceil(r.y + r.height)]})\n                if len(words) > MAX_WORDS:\n                    raise ValueError(\"recognition_limit\")\n        return words\n    finally:\n        if bitmap is not None:\n            bitmap.close()\n        writer.close()\n        stream.close()\n\n\ndef code_box(points, width, height):\n    left = math.floor(min(float(point[0]) for point in points))\n    top = math.floor(min(float(point[1]) for point in points))\n    right = math.ceil(max(float(point[0]) for point in points)) + 1\n    bottom = math.ceil(max(float(point[1]) for point in points)) + 1\n    return [max(0, left), max(0, top), min(width, right), min(height, bottom)]\n\n\ndef recognize_codes(rgb):\n    import cv2\n    import numpy\n    pixels = cv2.cvtColor(numpy.asarray(rgb), cv2.COLOR_RGB2BGR)\n    width, height = rgb.size\n    codes = []\n    qr = cv2.QRCodeDetector()\n    detected, points = qr.detectMulti(pixels)\n    if detected:\n        decoded, texts, decoded_points, _ = qr.detectAndDecodeMulti(pixels)\n        if not decoded or decoded_points is None or len(points) != len(decoded_points) or len(texts) != len(points) or any(not text for text in texts):\n            raise ValueError(\"code_undecodable\")\n        codes.extend({\"kind\": \"qr\", \"text\": text, \"box\": code_box(polygon, width, height)} for text, polygon in zip(texts, decoded_points))\n    linear = cv2.barcode.BarcodeDetector()\n    # Two bounded scales of the same decoder; no iterative retries or fallback\n    # engine. Per-axis ratios preserve canonical coordinates for odd sizes.\n    for divisor in (1, 2):\n        sample_width, sample_height = max(1, width // divisor), max(1, height // divisor)\n        if sample_width <= 40 or sample_height <= 40:\n            continue\n        sample = pixels if divisor == 1 else cv2.resize(pixels, (sample_width, sample_height), interpolation=cv2.INTER_AREA)\n        detected, points = linear.detect(sample)\n        if detected:\n            decoded, texts, types, decoded_points = linear.detectAndDecodeWithType(sample)\n            if not decoded or decoded_points is None or len(points) != len(decoded_points) or len(texts) != len(points) or len(types) != len(texts) or any(not text for text in texts) or any(not kind for kind in types):\n                raise ValueError(\"code_undecodable\")\n            if len(codes) + len(texts) > MAX_CODES:\n                raise ValueError(\"recognition_limit\")\n            scale_x, scale_y = width / sample_width, height / sample_height\n            for text, kind, polygon in zip(texts, types, decoded_points):\n                raw_points = [[float(point[0]), float(point[1])] for point in polygon]\n                mapped = [[point[0] * scale_x, point[1] * scale_y] for point in raw_points]\n                codes.append({\"kind\": \"barcode\", \"text\": text, \"box\": code_box(mapped, width, height),\n                              \"linear\": {\"width\": sample_width, \"height\": sample_height, \"polygon\": raw_points, \"format\": kind}})\n    if len(codes) > MAX_CODES:\n        raise ValueError(\"recognition_limit\")\n    return codes\n\n\ndef main():\n    size = struct.unpack(\">I\", exact_read(4))[0]\n    if size < 1 or size > 2048:\n        raise ValueError(\"input_invalid\")\n    meta = json.loads(exact_read(size).decode(\"utf-8\", \"strict\"))\n    if set(meta) != {\"schema\", \"bytes\", \"sourceHash\", \"processorHash\", \"language\", \"version\"} or meta[\"schema\"] != 1 or meta[\"version\"] != VERSION:\n        raise ValueError(\"input_invalid\")\n    if type(meta[\"bytes\"]) is not int or not 1 <= meta[\"bytes\"] <= MAX_SOURCE:\n        raise ValueError(\"source_limit\")\n    data = exact_read(meta[\"bytes\"])\n    try:\n        if sys.stdin.buffer.read(1) or hashlib.sha256(data).hexdigest() != meta[\"sourceHash\"]:\n            raise ValueError(\"source_changed\")\n        rgba, rgb, normalized, transform = canonical(data)\n        words = asyncio.run(asyncio.wait_for(recognize(normalized, meta[\"language\"], *rgb.size), 35))\n        codes = recognize_codes(rgb)\n        if sum(len(row[\"text\"]) for row in words + codes) > MAX_TEXT:\n            raise ValueError(\"recognition_limit\")\n        payload = rgba.tobytes()\n        header = {\"schema\": 1, \"width\": rgba.width, \"height\": rgba.height, \"rgbaBytes\": len(payload),\n                  \"sourceHash\": meta[\"sourceHash\"], \"processorHash\": meta[\"processorHash\"], \"frames\": 1,\n                  \"orientationApplied\": True, \"ocrComplete\": True, \"codesComplete\": True,\n                  \"transform\": transform, \"words\": words, \"codes\": codes,\n                  \"recognitionConfidence\": \"unknown\", \"language\": meta[\"language\"],\n                  \"codeProfile\": \"opencv-qr-and-opencv-supported-linear-v3-source-support\"}\n        wire = json.dumps(header, ensure_ascii=True, separators=(\",\", \":\")).encode(\"utf-8\")\n        if len(wire) > MAX_META:\n            raise ValueError(\"output_limit\")\n        sys.stdout.buffer.write(struct.pack(\">I\", len(wire)))\n        sys.stdout.buffer.write(wire)\n        sys.stdout.buffer.write(payload)\n        sys.stdout.buffer.flush()\n    finally:\n        data[:] = b\"\\0\" * len(data)\n\n\nif __name__ == \"__main__\":\n    try:\n        main()\n    except BaseException as exc:\n        known = {\"input_incomplete\", \"input_invalid\", \"source_limit\", \"source_changed\",\n                 \"format_unsupported\", \"pixel_limit\", \"animation_unsupported\",\n                 \"orientation_invalid\", \"ocr_language_missing\", \"ocr_dimension_unsupported\",\n                 \"recognition_limit\", \"code_undecodable\", \"output_limit\"}\n        code = \"component_failed\"\n        if isinstance(exc, ImportError):\n            code = \"component_missing\"\n        elif isinstance(exc, TimeoutError):\n            code = \"recognition_timeout\"\n        elif isinstance(exc, ValueError) and len(exc.args) == 1 and type(exc.args[0]) is str and exc.args[0] in known:\n            code = exc.args[0]\n        # Only this finite code vocabulary is disclosed, never exception text,\n        # paths, recognized text or traceback. Partial success output remains\n        # malformed and is rejected by the parent, not repaired or filtered.\n        raw = json.dumps({\"schema\": 1, \"code\": code}, separators=(\",\", \":\")).encode(\"ascii\")\n        try:\n            sys.stdout.buffer.write(struct.pack(\">I\", len(raw)) + raw)\n            sys.stdout.buffer.flush()\n        except BaseException:\n            pass\n        sys.exit(2)\n";
  const INVENTORY = '4e84862cf50907c84b14a55dcabcc347ae3a52e78a88031b7ecb878565d6735f', owners = new WeakSet();
  const LIMIT = Object.freeze({ source: 8388608, pixels: 8000000, metadata: 2097152, stderr: 16384, processMs: 60000, settleMs: 2000 });
  const hash = b => cryptoApi.createHash('sha256').update(b).digest('hex'), internalErrors = new WeakSet();
  function fail(suffix, unknown = false) {
    const error=Object.assign(Error('privacy.image_processor_' + suffix), {code:'privacy.image_processor_' + suffix,retry:false,
      ...(unknown?{helperMayStillRun:true,ownershipRetained:true}:{})});internalErrors.add(error);return error;
  }
  const controlled = cause => internalErrors.has(cause) ? cause : Object.assign(fail('dependency_failed'),{cause});
  const fold = text => proc.platform === 'win32' ? text.toLowerCase() : text;
  const shape = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
  const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(k => a[k] === b[k]);
  const frozenProof = value => value?.schema === 1 && value.verificationKind === 'offline-artifact-inventory'
    && value.dependencyFilesVerified === true && value.pythonVersion === '3.12.10' && value.runtimeArtifacts === 4987
    && value.verifiedRuntimeBytes === 413946142 && value.sourceArchiveVerified === true && value.verifiedSourceBytes === 19922194
    && value.installsPerformed === false && value.mediaProcessingEnabled === false && value.mediaEgressEnabled === false;
  function refineLinearBox(rgba, width, height, code, budget, check) {
    // A decoded native polygon seeds source ink support; it is never itself a
    // claim that detector-localized strip height covers the complete barcode.
    check();
    const reject = () => { throw fail('worker_code_undecodable'); };
    const support=code.linear;
    if (!shape(code,'box,kind,linear,text') || code.kind!=='barcode' || typeof code.text!=='string'
      || !shape(support,'format,height,polygon,width') || !Number.isSafeInteger(support.width) || !Number.isSafeInteger(support.height)
      || !((support.width===width&&support.height===height)
        || (support.width===Math.max(1,Math.floor(width/2))&&support.height===Math.max(1,Math.floor(height/2))))
      || !Array.isArray(support.polygon) || support.polygon.length!==4
      || support.polygon.some(p=>!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||!Number.isFinite(p[1])
        ||p[0]<-support.width||p[0]>support.width*2||p[1]<-support.height||p[1]>support.height*2)) reject();
    // Validate only the value/type already returned by the same native engine.
    // This never searches for or produces a decoded value. The pinned native
    // source supports EAN-8/EAN-13 and its leading-zero UPC-A representation.
    const digits=support.format==='EAN_13'?13:support.format==='EAN_8'?8:support.format==='UPC_A'?12:0;
    if(!digits||!new RegExp('^[0-9]{'+digits+'}$').test(code.text))reject();
    let checksum=0;for(let i=code.text.length-1,weight=1;i>=0;i--,weight=4-weight)checksum+=Number(code.text[i])*weight;
    if(checksum%10)reject();
    const value=support.format==='UPC_A'?'0'+code.text:code.text,L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'],parities=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'],invert=s=>s.replace(/[01]/g,c=>c==='0'?'1':'0');
    const pattern=support.format==='EAN_8'?'101'+[...value.slice(0,4)].map(d=>L[Number(d)]).join('')+'01010'+[...value.slice(4)].map(d=>invert(L[Number(d)])).join('')+'101'
      :'101'+[...value.slice(1,7)].map((d,i)=>parities[Number(value[0])][i]==='L'?L[Number(d)]:invert(L[Number(d)]).split('').reverse().join('')).join('')+'01010'+[...value.slice(7)].map(d=>invert(L[Number(d)])).join('')+'101';
    const expected=pattern.match(/0+|1+/g).map(s=>s.length),quietModules=support.format==='EAN_13'?[11,7]:support.format==='UPC_A'?[9,9]:[7,7];
    const sx=width/support.width,sy=height/support.height,points=support.polygon.map(p=>[p[0]*sx,p[1]*sy]);
    const coarse=[Math.max(0,Math.floor(Math.min(...points.map(p=>p[0])))),Math.max(0,Math.floor(Math.min(...points.map(p=>p[1])))),
      Math.min(width,Math.ceil(Math.max(...points.map(p=>p[0])))+1),Math.min(height,Math.ceil(Math.max(...points.map(p=>p[1])))+1)];
    if (!Array.isArray(code.box)||code.box.length!==4||code.box.some((v,i)=>v!==coarse[i])||coarse[0]>=coarse[2]||coarse[1]>=coarse[3]) reject();
    const edges=points.map((p,i)=>[points[(i+1)%4][0]-p[0],points[(i+1)%4][1]-p[1]]),lengths=edges.map(v=>Math.hypot(...v));
    if (lengths.some(v=>!Number.isFinite(v)||v<1)) reject();
    let side=0;for(let i=1;i<4;i++)if(lengths[i]>lengths[side])side=i;
    const ux=edges[side][0]/lengths[side],uy=edges[side][1]/lengths[side],vx=-uy,vy=ux;
    const us=points.map(p=>p[0]*ux+p[1]*uy),vs=points.map(p=>p[0]*vx+p[1]*vy),u0=Math.min(...us),u1=Math.max(...us),v0=Math.min(...vs),v1=Math.max(...vs),spanU=u1-u0,spanV=v1-v0;
    let winding=0;for(let i=0;i<4;i++){const a=edges[i],b=edges[(i+1)%4],cross=a[0]*b[1]-a[1]*b[0];if(Math.abs(cross)<0.001||winding&&Math.sign(cross)!==winding)reject();winding=Math.sign(cross);}
    if(spanU<2||spanV<1||spanU<spanV)reject();
    const pad=Math.max(2,Math.ceil(sx),Math.ceil(sy)),search=[];
    // Observe the entire source along U, rather than stopping in a possibly
    // internal white gap. The bounded V strip still rejects truncated strokes.
    const sourceU=[[0,0],[width,0],[0,height],[width,height]].map(p=>p[0]*ux+p[1]*uy);
    for(const u of [Math.min(...sourceU),Math.max(...sourceU)])for(const v of [v0-spanU/2,v1+spanU/2])search.push([u*ux+v*vx,u*uy+v*vy]);
    const left=Math.max(0,Math.floor(Math.min(...search.map(p=>p[0])))),top=Math.max(0,Math.floor(Math.min(...search.map(p=>p[1])))),
      right=Math.min(width,Math.ceil(Math.max(...search.map(p=>p[0])))),bottom=Math.min(height,Math.ceil(Math.max(...search.map(p=>p[1])))),rw=right-left,rh=bottom-top,size=rw*rh;
    if(!Number.isSafeInteger(size)||size<1||size>budget.remaining)throw fail('worker_recognition_limit');budget.remaining-=size;
    let gray,seen,queue;
    try {
      gray=new Uint8Array(size);seen=new Uint8Array(size);queue=new Int32Array(size);
      const hist=new Uint32Array(256);let total=0;
      try {
        for(let y=0;y<rh;y++){if(!(y%32))check();for(let x=0;x<rw;x++){const at=((y+top)*width+x+left)*4,alpha=rgba[at+3],r=Math.round((rgba[at]*alpha+255*(255-alpha))/255),g=Math.round((rgba[at+1]*alpha+255*(255-alpha))/255),b=Math.round((rgba[at+2]*alpha+255*(255-alpha))/255),value=Math.round((299*r+587*g+114*b)/1000);gray[y*rw+x]=value;hist[value]++;total+=value;}}
        let count=0,sum=0,best=-1,threshold=0;
        for(let i=0;i<256;i++){count+=hist[i];sum+=i*hist[i];if(!count||count===size)continue;const delta=sum/count-(total-sum)/(size-count),score=count*(size-count)*delta*delta;if(score>best){best=score;threshold=i;}}
        if(best<=0)reject();
        const inside=(x,y)=>{for(let i=0;i<4;i++){const p=points[i],e=edges[i];if((e[0]*(y-p[1])-e[1]*(x-p[0]))*winding<-0.001)return false;}return true;};
        const candidates=[];
        for(const dark of [true,false]){
          seen.fill(0);const selected=[],unseeded=[];let invalid=false;
          const ink=at=>dark?gray[at]<=threshold:gray[at]>threshold;
          for(let root=0;root<size;root++){
            if(!(root%4096))check();if(seen[root]||!ink(root))continue;
            if(--budget.components<0)throw fail('worker_recognition_limit');
            let head=0,tail=1,count=0,seeds=0,minX=rw,maxX=0,minY=rh,maxY=0,minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;queue[0]=root;seen[root]=1;
            while(head<tail){if(!(head%4096))check();const at=queue[head++],x=at%rw,y=Math.floor(at/rw),px=x+left+0.5,py=y+top+0.5,u=px*ux+py*uy,v=px*vx+py*vy;count++;if(inside(px,py))seeds++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v);
              for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if((!dx&&!dy)||x+dx<0||x+dx>=rw||y+dy<0||y+dy>=rh)continue;const next=(y+dy)*rw+x+dx;if(!seen[next]&&ink(next)){seen[next]=1;queue[tail++]=next;}}
            }
            const c={minX,maxX,minY,maxY,minU,maxU,minV,maxV,count},du=maxU-minU+1,dv=maxV-minV+1;
            // A single surround touching every ROI side is the background,
            // never evidence for masking an entire image/column.
            if(minX===0&&maxX===rw-1&&minY===0&&maxY===rh-1)continue;
            if(!seeds){if(du<=spanU/8)unseeded.push(c);continue;}
            if(minX===0||maxX===rw-1||minY===0||maxY===rh-1
              ||du>spanU/8||dv<Math.max(2*du,spanV/2)){invalid=true;continue;}
            selected.push(c);if(selected.length>128)throw fail('worker_recognition_limit');
          }
          if(invalid||selected.length<4)continue;
          const minU=Math.min(...selected.map(c=>c.minU)),maxU=Math.max(...selected.map(c=>c.maxU)),commonLow=Math.max(...selected.map(c=>c.minV)),commonHigh=Math.min(...selected.map(c=>c.maxV)),commonV=commonHigh-commonLow+1;
          if(maxU-minU+1<spanU/2||commonV<spanV/2||unseeded.some((c,index)=>{if(!(index%64))check();return c.maxU>=minU&&c.minU<=maxU&&((c.maxV-c.minV+1)>=2*(c.maxU-c.minU+1)||selected.some(s=>Math.abs(s.minU-c.minU)<=pad&&Math.abs(s.maxU-c.maxU)<=pad));}))continue;
          // A partial strip cannot be called complete merely because its ROI
          // ends in whitespace. All guards/digits/parity/checksum of the given
          // native value must match the complete source stroke/gap run vector.
          const ordered=[...selected].sort((a,b)=>a.minU-b.minU),observed=[];
          for(let i=0;i<ordered.length;i++){observed.push(ordered[i].maxU-ordered[i].minU+1);if(i+1<ordered.length)observed.push(ordered[i+1].minU-ordered[i].maxU-1);}
          const module=(maxU-minU+1)/pattern.length,tolerance=Math.min(1.5,module*0.45);
          if(module<1||observed.length!==expected.length)continue;
          let complete=false;
          for(const reverse of [false,true]){
            const runs=reverse?[...expected].reverse():expected;
            if(observed.some((n,i)=>n<=0||Math.abs(n-runs[i]*module)>tolerance))continue;
            const quiet=reverse?[...quietModules].reverse():quietModules,guards=[[minU-Math.max(pad,module*quiet[0]),minU],[maxU,maxU+Math.max(pad,module*quiet[1])]];
            let clear=true;
            for(const band of guards)for(const u of band)for(const v of [commonLow,commonHigh]){const x=u*ux+v*vx,y=u*uy+v*vy;if(x<left+0.5||x>right-0.5||y<top+0.5||y>bottom-0.5)clear=false;}
            if(!clear)continue;
            for(let at=0;at<size;at++){if(!(at%4096))check();if(!ink(at))continue;const x=at%rw+left+0.5,y=Math.floor(at/rw)+top+0.5,u=x*ux+y*uy,v=x*vx+y*vy;if(v>=commonLow&&v<=commonHigh&&((u>=guards[0][0]&&u<minU)||(u>maxU&&u<=guards[1][1]))){clear=false;break;}}
            if(clear){complete=true;break;}
          }
          if(!complete)continue;
          const bounds=[Math.min(coarse[0],left+Math.min(...selected.map(c=>c.minX))),Math.min(coarse[1],top+Math.min(...selected.map(c=>c.minY))),
            Math.max(coarse[2],left+Math.max(...selected.map(c=>c.maxX))+1),Math.max(coarse[3],top+Math.max(...selected.map(c=>c.maxY))+1)];
          // Extent comes from connected, seeded source strokes, not the search
          // ROI or a geometric padding rectangle.
          if(bounds[0]===0&&bounds[1]===0&&bounds[2]===width&&bounds[3]===height)continue;
          candidates.push(bounds);
        }
        check();if(candidates.length!==1)reject();return candidates[0];
      } finally { hist.fill(0); }
    } finally { if(gray)gray.fill(0);if(seen)seen.fill(0);if(queue)queue.fill(0); }
  }

  async function create({ runtimeRoot, sourceRoot, language = 'en-US', resourceProfile = 'legacy-full-4987-v1' } = {}) {
    if (proc.platform !== 'win32') throw fail('platform_unsupported');
    if (![runtimeRoot,sourceRoot].every(v => typeof v === 'string' && v.length < 4096 && nodePath.isAbsolute(v) && nodePath.resolve(v) === v)
      || typeof language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) throw fail('host_invalid');
    if (resourceProfile !== 'legacy-full-4987-v1') {
      // The host selects an explicit code-pinned profile. Browser requests,
      // arbitrary manifests, receipts and environment booleans cannot activate
      // it. The new candidate has no execution-qualified resource/source owner.
      try {
        const adapter = require('../tools/verify-media-profile.cjs');
        const capture = adapter.captureMediaProfile({profileId:resourceProfile,workerHash:hash(SCRIPT),language});
        adapter.assertMediaProfileExecutable(capture);
      } catch (cause) {
        const suffix = cause?.code === 'media.profile_qualification_pending' ? 'resource_profile_pending'
          : cause?.code === 'media.profile_unknown' ? 'resource_profile_unknown' : 'resource_profile_invalid';
        throw Object.assign(fail(suffix),{cause});
      }
      throw fail('resource_profile_pending');
    }
    // Reuse the shipped, immutable 4987-file/21-distribution and source-sidecar
    // gate. A package receipt is never itself a payload/disclosure capability.
    let verifyMediaArtifacts;
    try { ({ verifyMediaArtifacts } = require('../tools/verify-media-artifacts.cjs')); }
    catch { throw fail('component_missing'); }
    const verify = async signal => {try{const proof=await verifyMediaArtifacts(runtimeRoot,sourceRoot,{signal});if(!frozenProof(proof))throw fail('dependency_receipt');}catch(cause){throw controlled(cause);}};
    const executable = nodePath.join(runtimeRoot,'python_embed','python.exe');
    const executableStat = async () => {
      const st = await io.lstat(executable,{bigint:true});
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || fold(await io.realpath(executable)) !== fold(executable)) throw fail('executable_alias');
      return st;
    };
    await verify(); const originalExecutable = await executableStat();
    const processorHash = hash(JSON.stringify({ schema:1, version:VERSION, workerHash:hash(SCRIPT), inventory:INVENTORY, language }));
    const captures = new WeakSet(), frames = new WeakMap(); let active = null, retired = false, uncertain = false, retained = null, poisoned = false;
    const frameStamp = frame => hash(JSON.stringify({ ...frame, rgba: hash(frame.rgba) }));
    function assertCoverage(frame) {
      const stamp = frames.get(frame);
      if (retired || uncertain || poisoned || !stamp || !Buffer.isBuffer(frame.rgba) || frameStamp(frame) !== stamp) throw fail('coverage_unverified', uncertain);
      return true;
    }
    const latch = record => {
      uncertain = true;
      if (!retained) retained = { record, timer:setInterval(() => { void record.child; void record.source; },60000) };
    };
    const assert = snapshot => {
      if (retired || uncertain || poisoned || !captures.has(snapshot) || snapshot.hash !== processorHash || snapshot.version !== VERSION) throw fail('owner_changed',uncertain);
      return true;
    };
    function capture() {
      if (retired || uncertain || poisoned) throw fail('owner_changed',uncertain);
      const snapshot = Object.freeze({ hash:processorHash, version:VERSION }); captures.add(snapshot); return snapshot;
    }
    function decode(bytes, sourceHash, check) {
      if (bytes.length < 5) throw fail('output_invalid');
      const size=bytes.readUInt32BE(0); if (size<1 || size>LIMIT.metadata || size+4>bytes.length) throw fail('output_invalid');
      const raw=bytes.subarray(4,4+size),text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw fail('output_invalid');
      let data;try{data=JSON.parse(text);}catch{throw fail('output_invalid');}
      if (!shape(data,'codeProfile,codes,codesComplete,frames,height,language,ocrComplete,orientationApplied,processorHash,recognitionConfidence,rgbaBytes,schema,sourceHash,transform,width,words')
        ||data.schema!==1||data.sourceHash!==sourceHash||data.processorHash!==processorHash||data.language!==language
        ||data.frames!==1||data.orientationApplied!==true||data.ocrComplete!==true||data.codesComplete!==true
        ||data.recognitionConfidence!=='unknown'||data.codeProfile!=='opencv-qr-and-opencv-supported-linear-v3-source-support'
        ||!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||data.width<1||data.height<1||data.width*data.height>LIMIT.pixels
        ||data.rgbaBytes!==data.width*data.height*4||bytes.length!==4+size+data.rgbaBytes
        ||!Array.isArray(data.words)||data.words.length>20000||!Array.isArray(data.codes)||data.codes.length>4096)throw fail('output_invalid');
      // The existing MediaImageContract performs the full word/box/transform and
      // detector validation. This owner cannot mint its artifact or authorization.
      const rgba=Buffer.from(bytes.subarray(4+size));
      try {
        const budget={remaining:LIMIT.pixels*2,components:32768},codes=[];
        for(const code of data.codes){check();if(code?.kind!=='barcode'){codes.push(code);continue;}
          const box=refineLinearBox(rgba,data.width,data.height,code,budget,check),prior=codes.find(value=>value.kind==='barcode'&&Math.max(0,Math.min(value.box[2],box[2])-Math.max(value.box[0],box[0]))*Math.max(0,Math.min(value.box[3],box[3])-Math.max(value.box[1],box[1]))>Math.min((value.box[2]-value.box[0])*(value.box[3]-value.box[1]),(box[2]-box[0])*(box[3]-box[1]))/2);
          if(prior){if(prior.text!==code.text)throw fail('worker_code_undecodable');const merged=[Math.min(prior.box[0],box[0]),Math.min(prior.box[1],box[1]),Math.max(prior.box[2],box[2]),Math.max(prior.box[3],box[3])];if(merged[0]===0&&merged[1]===0&&merged[2]===data.width&&merged[3]===data.height)throw fail('worker_code_undecodable');prior.box=merged;}else codes.push({kind:'barcode',text:code.text,box});
        }
        data.codes=codes;delete data.rgbaBytes;delete data.schema;check();return Object.assign(data,{rgba});
      } catch(error){rgba.fill(0);throw error;}
    }
    function workerRefusal(bytes) {
      if(bytes.length<5||bytes.length>4096)return fail('process_failed');
      const size=bytes.readUInt32BE(0);if(size+4!==bytes.length)return fail('process_failed');
      let value;try{value=JSON.parse(bytes.subarray(4).toString('utf8'));}catch{return fail('process_failed');}
      const codes=['input_incomplete','input_invalid','source_limit','source_changed','format_unsupported','pixel_limit','animation_unsupported',
        'orientation_invalid','ocr_language_missing','ocr_dimension_unsupported','recognition_limit','code_undecodable','output_limit','component_failed','component_missing','recognition_timeout'];
      return shape(value,'code,schema')&&value.schema===1&&codes.includes(value.code)?fail('worker_'+value.code):fail('process_failed');
    }
    function start({ source, sourceHash, signal, deadline, processor } = {}) {
      assert(processor);
      if (active || !Buffer.isBuffer(source) || source.length<1 || source.length>LIMIT.source || hash(source)!==sourceHash
        ||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+LIMIT.processMs||signal?.aborted)throw fail('input_invalid');
      const record={source:Buffer.from(source),child:null,spawn:false,exit:false,close:false,exitCode:null,closeCode:null,
        stopped:null,settled:false,output:[],outputBytes:0,stderrBytes:0,wire:null,timer:null,settleTimer:null};active=record;
      let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});
      const wipe = () => {record.source.fill(0);if(record.wire)record.wire.fill(0);for(const b of record.output)b.fill(0);record.output.length=0;};
      const settle = (error,value) => {if(record.settled)return;if(error&&uncertain&&Object.getOwnPropertyDescriptor(error,'helperMayStillRun')?.value!==true)error=Object.assign(fail('process_uncertain',true),{cause:error});record.settled=true;clearTimeout(record.timer);clearTimeout(record.settleTimer);signal?.removeEventListener('abort',abort);
        if(record.close||!record.child)wipe();if(active===record)active=null;error?reject(error):resolve(value);};
      const stop = suffix => {
        if(record.stopped||record.settled)return;record.stopped=suffix;clearTimeout(record.timer);
        if(!record.child||record.close){settle(fail(suffix));return;}
        record.settleTimer=setTimeout(()=>{latch(record);settle(fail(suffix,true));},LIMIT.settleMs);
        try{record.child.kill();}catch{ /* A kill request/throw is not actual close. */ }
      };
      record.stop=stop;
      const abort = () => stop('cancelled');signal?.addEventListener('abort',abort,{once:true});
      record.timer=setTimeout(()=>stop('timeout'),Math.max(1,deadline-Date.now()));
      const guarded = work => (...args) => {try{work(...args);}catch{stop('transport_failed');}};
      const admitted = () => {
        if(record.settled||record.stopped||active!==record)return false;
        if(retired||uncertain||signal?.aborted||Date.now()>=deadline)throw fail('cancelled');
        return true;
      };
      void(async()=>{
        try{
          await verify(signal);if(!admitted())return;
          const currentExecutable=await executableStat();if(!admitted())return;
          if(!same(originalExecutable,currentExecutable))throw fail('executable_changed');
          const environment={};for(const key of['SystemRoot','SystemDrive','WINDIR','TEMP','TMP'])if(typeof proc.env[key]==='string')environment[key]=proc.env[key];
          // -I ignores user Python paths/site and -B prevents a new bytecode cache.
          if(!admitted())return;
          record.child=childProcess.spawn(executable,['-I','-B','-X','utf8','-c',SCRIPT],{windowsHide:true,shell:false,env:environment,cwd:nodePath.dirname(executable),stdio:['pipe','pipe','pipe']});
          const child=record.child;
          child.once('spawn',guarded(()=>{record.spawn=true;}));child.once('exit',guarded(code=>{record.exit=true;record.exitCode=code;}));
          child.once('error',guarded(()=>{poisoned=true;stop('process_failed');}));
          const transportError=guarded(()=>{poisoned=true;stop('transport_failed');});
          child.stdout.on('error',transportError);child.stderr.on('error',transportError);child.stdin.on('error',transportError);
          child.stdout.on('data',guarded(bytes=>{if(record.settled||record.stopped){bytes.fill(0);return;}record.outputBytes+=bytes.length;
            if(record.outputBytes>4+LIMIT.metadata+LIMIT.pixels*4){bytes.fill(0);stop('output_limit');return;}record.output.push(Buffer.from(bytes));}));
          child.stderr.on('data',guarded(bytes=>{record.stderrBytes+=bytes.length;bytes.fill(0);if(record.stderrBytes>LIMIT.stderr)stop('stderr_limit');}));
          child.once('close',(code)=>{void(async()=>{
            record.close=true;record.closeCode=code;
            if(record.settled){wipe();return;}
            if(record.stopped){settle(fail(record.stopped));return;}
            if(!record.spawn||!record.exit||record.exitCode!==code||record.stderrBytes)throw fail('process_failed');
            if(code!==0){const bytes=Buffer.concat(record.output,record.outputBytes);try{throw code===2?workerRefusal(bytes):fail('process_failed');}finally{bytes.fill(0);}}
            await verify(signal);if(!admitted())return;
            const currentExecutable=await executableStat();if(!admitted())return;
            if(!same(originalExecutable,currentExecutable))throw fail('executable_changed');
            const bytes=Buffer.concat(record.output,record.outputBytes);let frame,published=false;
            try{frame=decode(bytes,sourceHash,()=>{if(!admitted())throw fail('cancelled');});if(!admitted())return;frames.set(frame,frameStamp(frame));settle(null,frame);published=true;}
            finally{bytes.fill(0);if(frame&&!published)frame.rgba.fill(0);}
          })().catch(error=>settle(controlled(error)));});
          const meta=Buffer.from(JSON.stringify({schema:1,bytes:record.source.length,sourceHash,processorHash,language,version:VERSION}));
          const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);record.wire=Buffer.concat([size,meta,record.source]);meta.fill(0);size.fill(0);
          child.stdin.end(record.wire,guarded(()=>record.wire.fill(0)));
        }catch(error){if(record.child)stop('transport_failed');else settle(controlled(error));}
      })();
      return Object.freeze({promise,finish({failed=false}={}){
        if(!record.settled)stop(failed?'consumer_cancelled':'finish_before_completion');
        if(record.child&&!record.close){latch(record);return Object.freeze({closed:false,helperMayStillRun:true,ownershipRetained:true});}
        return Object.freeze({closed:true,helperMayStillRun:uncertain,ownershipRetained:uncertain});
      }});
    }
    const owner=Object.freeze({capture,assert,start,assertCoverage,invalidate(){retired=true;const record=active;if(record){record.stop('invalidated');if(record.child&&!record.close)latch(record);}},
      helperMayStillRun:()=>uncertain,profile:Object.freeze({version:VERSION,language,recognitionConfidence:'unknown',automaticDelivery:false,
        codeProfile:'opencv-qr-and-opencv-supported-linear-v3-source-support',dependencyInventory:INVENTORY})});
    owners.add(owner);return owner;
  }
  return Object.freeze({create,VERSION,isOwner:value=>owners.has(value)});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'),require('node:child_process'),process);
