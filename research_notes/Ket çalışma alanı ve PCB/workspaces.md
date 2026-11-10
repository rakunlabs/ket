# Ket: çok projeli çalışma alanı sekmeleri ve MCP ile otomatik açma

Araştırma tarihi: **10 Kasım 2026**. Uygulama kodu salt okunur incelendi; paket kurulmadı, uygulama değiştirilmedi, test çalıştırılmadı. Aşağıdaki “Cited Findings” mevcut davranış; “Inferences” uygulanması önerilen, henüz mevcut olmayan tasarımdır. Yerel bağlantılar bu notun konumuna göredir; satır aralıkları araştırma anındaki dosyalara aittir.

## 1. Bugün hangi parçalar mevcut, çoklu proje için hangi izolasyonlar eksik?

### Takeaway

Ket'in belge ve sunucu eşzamanlama katmanları zaten proje/dal bazlıdır; ana engel, uygulamanın aynı anda yalnızca tek `Workspace` yaşatmasıdır. Birkaç `Workspace` bileşenini CSS ile saklamak tek başına güvenli çözüm değildir: global proje yetkisi, pencere klavye olayları, worker temizliği ve renderer sahipliği önce ayrılmalıdır.

### Cited Findings

- **Tek proje yaşam döngüsü:** `_ui/src/App.svelte:15–23`, `router.project` değiştiğinde `{#key router.project}` içindeki `Workspace`'i yeniden oluşturur; proje listesi ve ayarlar bu bileşeni kaldırır. Router `#/p/<id>`, liste ve ayarları bilir; açık projeler koleksiyonu yoktur. — [App](../../_ui/src/App.svelte), [Router:1–45](../../_ui/src/lib/router.svelte.ts).
- **Session doğal izolasyon birimi:** Her `Workspace` kendi `new Session(projectID)` örneğini yaratır; belge, seçili öğe, head/top, op listesi, komut zinciri, dal ve proposal durumu Session içindedir. `undo/redo` bu Session'ın WS bağlantısına gider. — [Workspace:19–24,55–69](../../_ui/src/pages/Workspace.svelte), [Session:44–108,268–309,376–392](../../_ui/src/lib/session.svelte.ts).
- **Worker proje başına ama kapanış eksik:** `Session` kendi `KernelClient`'ını; `KernelClient` kendi dedicated Worker'ını ve son build belgesini tutar. `Session.close()` yalnızca closed bayrağını, interval ve WS'yi kapatır; `KernelClient` dosyasında dispose/terminate metodu yoktur. Böylece mevcut proje değiştirme akışı bile worker sonlandırmayı açıkça yapmıyor. — [Session:63,143–147](../../_ui/src/lib/session.svelte.ts), [KernelClient:22–88](../../_ui/src/lib/kernel-client.ts). `Worker.terminate()` anında durdurur, işlemi bitirme fırsatı vermez. — [MDN Worker.terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate).
- **`connected` ≠ hazır:** `reload()` replay sonunda `void rebuild()` çağırır; `open()` build'i beklemeden `connect()` eder; `hello` alınca `connected=true` olur. Sunucu `Join` ile executor listesine alır; kernel/renderer hazır bildirimi yoktur. — [Session:126–175,177–211](../../_ui/src/lib/session.svelte.ts), [Hub:106–135,341–405](../../internal/hub/hub.go).
- **Global erişim çakışması:** `account.access` tek alandır; `Workspace` mount'ta bunu proje erişimine atar, destroy'da undefined yapar. `account.canEdit/isOwner` buradan türetilir; Sidebar, Viewport, SchematicView ve Workspace bunu kullanır. Çoklu mount durumunda son yüklenen/kapanan proje diğerlerinin UI yetkisini bozar. Sunucuda proje kontrolleri bulunduğundan bunu doğrudan doğrulanmış yetki atlatma olarak değil, UI izolasyon hatası olarak değerlendirmek gerekir. — [Account:18–32](../../_ui/src/lib/account.svelte.ts), [Workspace:38,55–69,128](../../_ui/src/pages/Workspace.svelte), [SchematicView:17–18](../../_ui/src/components/SchematicView.svelte), [Sidebar](../../_ui/src/components/Sidebar.svelte), [Access:120–145](../../internal/access/access.go).
- **Klavye olayları global:** Workspace `Ctrl/Cmd+Z`, Y, F ve normal Tab'ı `svelte:window` üstünde dinler; Viewport M/Escape, SchematicView Delete/Backspace/Escape için ayrıca pencere dinleyicileri kurar. CSS ile saklanan birden çok bileşen bunları almaya devam eder. Özellikle normal Tab'ı `preventDefault()` ederek görünüm değiştirmek yeni erişilebilir sekme çubuğunun odak hareketiyle çakışır. — [Workspace:71–89,117](../../_ui/src/pages/Workspace.svelte), [Viewport:75–81,191](../../_ui/src/components/Viewport.svelte), [SchematicView:58–68,235](../../_ui/src/components/SchematicView.svelte).
- **Kamera/görünüm durumu bileşende:** 3D camera ve OrbitControls `Scene3D` örneğindedir; PCB pan/zoom ve yüz, şema pan/zoom kendi bileşenlerindedir; workspace modu local state'tir. Scene3D her örnek için sürekli rAF render döngüsü açar. — [Scene3D:42–78,99–105](../../_ui/src/lib/scene.ts), [BoardView:13–16,41–55](../../_ui/src/components/BoardView.svelte), [SchematicView:14–15,98–115](../../_ui/src/components/SchematicView.svelte), [Workspace:49–53](../../_ui/src/pages/Workspace.svelte).
- **Render yalnızca aktif UI sanılmamalı:** `session.renderer` Viewport mount'ta atanır/destroy'da temizlenir; PCB ve şema renderer'ları kendi mount'larında atanır ama destroy cleanup'larında kaldırılmaz. UI kaldırılıp Session korunursa 3D render eksik, diğer callback'ler eski bileşene bağlı kalabilir. — [Viewport:83–95](../../_ui/src/components/Viewport.svelte), [BoardView:19–39](../../_ui/src/components/BoardView.svelte), [SchematicView:88–96](../../_ui/src/components/SchematicView.svelte), [Session:317–325](../../_ui/src/lib/session.svelte.ts).
- **Chat proje bazlı ama kişiye özel değil:** UI konuşmaları `projectID` ile yükler, component içinde draft/provider/current/items/abort tutar; `ket.chat` yalnızca panelin görünürlüğü için global localStorage tercihidir. `Chat.svelte` içinde destroy cleanup yoktur. Sunucuda konuşmayı okuma/silme/durdurma/çalıştırma kontrolü ilgili projenin editor erişimidir, conversation sahibi kontrolü değildir. Bu mevcut ortak-proje paylaşım modeli kullanıcıya açık anlatılmalıdır; “her kullanıcının özel sohbeti” bugün varmış gibi sunulmamalıdır. — [Chat:23–41,110–179](../../_ui/src/components/Chat.svelte), [Workspace:26–47,176–178](../../_ui/src/pages/Workspace.svelte), [Chat API:19–96](../../internal/server/chat.go).
- **Sunucu belge izolasyonu mevcut:** Hub `projectID/branchID` ile indekslenir, op yayınları ilgili dalda kalır. Ancak executor son katılan non-viewer'dır; branch verilmezse main'i tercih eder, main yoksa projedeki herhangi bir dalı map dolaşımıyla seçebilir. Kullanıcı/workspace/readiness filtresi yoktur. `Sessions(projectID)` viewer dahil, bütün kullanıcı/dal oturumlarını sayar. — [Hub:102–104,190–220,341–374](../../internal/hub/hub.go).
- **Yetki kontrollerini korumak gerekli:** WS upgrade öncesinde proje Viewer erişimi, branch-project eşleşmesi, same-origin kabulü ve Viewer zorlaması var. MCP route `projects:write` ve `mcp` scope ister; tool çağrısı ilgili projede `need()` çalıştırır. WS'nin `User` alanına verilen değer ise `author(r)` ile üretilen görüntüleme/audit etiketidir; kararlı `identity.Subject` değildir. — [WS:25–69](../../internal/server/ws.go), [Server:111–118](../../internal/server/server.go), [Tools:83–94,277–283](../../internal/mcpserver/tools.go), [Auth:48–63](../../internal/server/auth.go).

### Inferences

**Önerilen UI modeli:** App seviyesinde kalıcı `WorkspaceShell` ve `WorkspaceManager` oluşturulsun. Her tarayıcı sayfası bir çalışma alanı instance'ıdır; uygulama içindeki proje sekmeleri bunun altındadır. İlk sürümde aynı projeye tek sekme yeterli; dal değişimi o sekmenin durumudur. İleride aynı projenin iki dalını yan yana açmak istenirse anahtar `{projectID, branchID}` yapılabilir; bu ayrı ürün kararıdır.

```text
WorkspaceManager (bir tarayıcı sayfası)
  workspaceID / connectionEpoch / activeProjectID / orderedProjectIDs
  entries[projectID]
    Session -> doc, ops, head/top, branch, serialized command chain
    access -> viewer/editor/owner; canEdit global rol + bu erişim
    ui -> 3d/pcb/sch, selection, camera+target, pcb/sch pan/zoom, panel widths
    chat -> conversationID, draft, provider, streaming ownership
    lifecycle -> opening | syncing | ready | degraded | suspended | closing | error
    capabilities -> edit, query, render3d, renderBoard, renderSchematic, export
```

- **Yetki global kalmasın:** `account` yalnızca kimlik ve global izinleri tutsun; `Session`/entry içindeki proje erişimi context veya prop ile bütün düzenleyicilere taşınsın. `undefined` erişim “henüz bilinmiyor” olsun; edit için fail-closed.
- **Giriş yalnızca aktif projeye:** Kısayollar Shell tarafından aktif entry'ye yönlendirilsin ya da her alt bileşene `active` kontrolü eklensin. Pointer etkileşimi, odak ve tüm window dinleyicileri de kapsansın. Normal Tab erişilebilir odak gezinmesine bırakılsın; 3D/PCB/SCH değiştirme için çakışmayan bir komut/kısayol tanımlansın.
- **İlk sürümde ayrı worker:** Worker'ın son belge cache'i olduğundan projeler arasında tek worker'ı sırayla vermek izolasyonu zorlaştırır. Başlangıçta Session başına worker korunsun; açık sekme sayısı/aktif işlem kotası konulsun. Görünmez projelerin etkileşimli rAF çizimi durdurulsun fakat komut executor'ı olmayı sürdürmeleri ayrı capability ile belirtilebilsin.
- **Render servisi yaşam döngüsünü ayırın:** Tab görünürlüğü değişince renderer yeteneği sessizce kaybolmamalı. İlk aşamada sınırlandırılmış sayıda paneli mount halinde tutup yalnızca aktif rAF çalıştırmak basit seçenektir; sonraki aşamada Session'a ait on-demand/offscreen renderer ve view-state snapshot/restore daha sağlamdır. Gizli sekmede `render` açıkça render işlemini tetiklemeli; animasyon karesini bekleyen sonsuz bir promise'e dönüşmemeli.
- **Kapanış sözleşmesi:** Yeni komutları reddet → in-flight commit/call durumunu çöz/drain et veya kullanıcıya busy dön → chat politikasına göre SSE abort/agent stop → renderer/observer/event/timer cleanup → bekleyen commit/worker promise'lerini açıklayıcı hata ile reject et → worker terminate. Close idempotent olsun. `open()`/`switchBranch()` sırasında kapanma yarışına AbortController veya generation guard eklensin.
- **UI durumu ve belgeyi ayırın:** Kamera, açık sekmeler ve chat draft op log'a yazılmasın; kullanıcı/instance/proje bazlı UI storage'da tutulabilir. Logout/kullanıcı değişiminde bellek, stream ve depolanmış restore anahtarları temizlensin; başka kullanıcının sekmeleri restore edilmesin. Sekme sırasını başka tarayıcı pencerelerine otomatik yansıtmayın.
- **Undo kapsamı değiştirilmesin:** Aktif projenin aktif dalında undo/redo; bütün workspace için ortak undo stack yaratmayın. Mevcut undo “herhangi bir yazarın son değişikliği” semantiğini UI açıklasın; kullanıcıya özel undo ayrı bir tasarım problemidir.

### Gaps

- Worker/WASM/GPU bellek maliyeti ölçülmedi; desteklenecek eşzamanlı proje sayısı veya MB limiti için sayı verilemez. Önce gerçek CAD+PCB belgeleriyle ölçüm gerekir.
- Mevcut chat'in ortak mı kişisel mi olması istendiği ürün kararıdır. Projeler arası izolasyon mevcut; aynı projede yazar bazlı gizlilik mevcut değildir.
- Mount edilmiş gizli canvas boyutları, WebGL context kaybı ve kapanış yarışları browser testiyle doğrulanmadı; yalnızca kod ve yaşam döngüsü riski tespit edildi.

## 2. MCP create_project bağlı Ket'te projeyi nasıl güvenli ve doğrulanabilir açmalı?

### Takeaway

Proje bazlı WS'ye ek olarak, proje açık değilken de yaşayan **kullanıcıya bağlı workspace kontrol bağlantısı** gerekir. `create_project` veritabanında oluşturma ile UI açılmasını ayrı sonuçlar olarak vermeli; modelleme komutları belirli workspace/proje/dalın readiness ack'inden sonra yönlendirilmelidir.

### Cited Findings

- Bugün `create_project` sadece `{name, description}` alır, store'da yaratır ve kullanıcıdan `#/p/<id>` bağlantısını açmasını isteyen not döndürür; otomatik açma yoktur. MCP `list_projects` ise `open_in_browser` bilgisini global `hub.Sessions(p.ID)>0` ile üretir. — [Tools:108–150,243–267,409–429](../../internal/mcpserver/tools.go).
- Proje belirtmeyen çağrı visible proje listesinden tam bir açık proje varsa onu seçer; birden fazlaysa hata verir. Ancak “açık” caller'ın workspace'i veya executor yeteneğiyle sınırlandırılmaz. Dolayısıyla viewer'ın açık projesi de “open” sayılabilir; bu bir kullanılabilirlik belirsizliğidir. Paylaşılan projede başka kullanıcının varlığı da bu bit üzerinden dolaylı ifşa edilir. — [Tools:367–406](../../internal/mcpserver/tools.go), [Hub:208–220,341–374](../../internal/hub/hub.go).
- MCP token kimliği tool context'e aktarılır; SDK TokenInfo `UserID=id.Subject` ile oturuma bağlanır. Buna rağmen tool `Call` veri yapısı yalnızca ProjectID/BranchID/Author taşır, workspace veya kararlı principal alanı taşımaz. — [MCP:32–48,65–96](../../internal/mcpserver/mcp.go), [Tools:54–61](../../internal/mcpserver/tools.go).
- Proposals map bugün yalnızca `call.Author` anahtarlıdır. Başka projeye geçildiğinde branch-project uyuşmazsa önceki proposal kaydı silinir; `finish_proposal` proje seçmeden yazarın tüm kaydını siler. Proposal bildirimi projenin bütün branch/session'larına gönderilir; frontend her `proposed` olayında o dala geçer. — [Tools:71–77,270–321](../../internal/mcpserver/tools.go), [Hub:433–446](../../internal/hub/hub.go), [Session:240–248](../../_ui/src/lib/session.svelte.ts).
- MCP güvenlik rehberi session ID'nin kimlik doğrulama yerine kullanılmamasını, bütün inbound isteklerin doğrulanmasını, session'ların kullanıcıya bağlanmasını ve tahmin edilemeyen ID'leri önerir/emreder. Bu, yeni workspace ID'yi bir yetki anahtarı saymamak için doğrudan dayanak sağlar. — [MCP Security Best Practices, Session Hijacking](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices).

### Inferences

#### Bağlantı ve sunucu modeli

1. **Kalıcı kontrol WS'si:** örneğin `/api/v1/workspaces/ws`; App/Shell mount olduğunda, liste ve ayarlar dahil bağlanır. Mevcut `/projects/{id}/ws` ilk sürümde aynen tutulabilir; kontrol WS'si yalnızca aç/kapat/aktif et ve capability/status protokolüdür. Böylece veri düzlemini bir kerede multiplex etmeye gerek yoktur.
2. **Ayrı principal:** Kimliği request context'teki doğrulanmış `identity.Subject` belirler. Hub/session'a `Subject` alanı ekleyin; `User`/`Author` sadece görüntüleme ve audit etiketi olarak kalsın. İstemcinin gönderdiği subject'e veya `mcp:...@username` string ayrıştırmasına güvenmeyin.
3. **Bağlı workspace kaydı:** `{workspaceID(random), subject, connectionEpoch, label, connectedAt, lastSeen, visibility, remoteControlPolicy, entries/capabilities}`. WorkspaceID kimlik doğrulama değildir. Listeleme, lookup, event gönderme ve ack işleme aynı subject ile eşleşmelidir. Başka kullanıcı aynı projede editor olsa bile UI aç/kapat hedefi olamaz.
4. **Rıza ve politika:** UI'da “bu çalışma alanını MCP kontrolüne aç” tercihi veya açık pairing/bind akışı olsun. Bir kullanıcının MCP yetkisi ile browser UI kontrolü bağlantılı ama aynı izin değildir. Auth devre dışı bir geliştirme modu desteklenirse boş subject'li herkesi aynı kullanıcı saymak yerine açık tek-instance/pairing politikası gereksin.
5. **Mevcut güvenlik korunmalı:** kontrol bağlantısında auth + same-origin, byte/rate/open-tab limitleri; her proje açmada caller'ın Viewer erişimi; her mutate'de Editor erişimi. Yetki değişiminde yeni komutlar fail-closed ve canlı session'lar invalidation/revalidation ile kapatılsın veya viewer'a düşürülsün. Aynı-origin kontrolü proje yetkisinin yerine geçmez.

#### Birden fazla pencere için deterministik hedef

- Hedef sırası: **açık `workspace` parametresi** → **MCP session'a sunucuda kaydedilmiş kullanıcı-onaylı binding** → **aynı subject'e ait tam bir uygun canlı workspace** → `workspace_ambiguous` / `workspace_offline`.
- Birden fazla uygun pencere varsa hata ile yalnızca caller'a ait kısa ID/label/status adaylarını döndürün; “son odaklanan”, “son bağlanan” veya map sırası ile sessiz seçim yapmayın. Focus/visibility yalnızca bilgi olsun, otomatik seçim yetkisi olmasın.
- Binding anahtarı `{subject, mcpSessionID}`; hedef workspace kapanırsa başka pencereye sessiz failover yapmayın. Yeniden bağlanma yeni connection epoch doğursun; eski ack geçersiz olsun. İstemci state'i kalıcı restore edilebilir, fakat kontrol yetkisi otomatik başka hesaba/pencereye devredilemez.
- `project` verilmediğinde en fazla **seçili workspace içindeki tam bir uygun hazır proje** kuralı uygulanabilir. Birden fazla projede `project` zorunlu olsun; kullanıcının o anda başka sekmeye tıklaması MCP'nin sonraki düzenlemesini başka belgeye taşımamalı.
- Executor seçimi `{subject, workspaceID, projectID, resolvedBranchID, capability, epoch}` üzerinde yapılsın. Main isteği main'e çözülmeli; main yok diye proposal branch'e düşülmemeli. Paylaşılan belge değişikliklerinin normal op broadcast'i devam eder; fakat kontrol olayları/call argümanları yalnızca seçili kullanıcı+workspace executor'ına gider.

#### Açılış protokolü ve readiness

```text
MCP create_project/open_project
  -> caller permission + deterministic target resolution
  -> server tracks requestID + workspace epoch + project/branch + deadline
  -> control WS: {t:workspace.open, requestID, projectID, branchID, activate}
  -> manager opens/reuses keyed entry, loads access+ops, starts worker/renderers
  -> project WS joined + head/branch synchronized + initial build settled
  -> browser: {t:workspace.open_result, requestID, projectID, branchID,
               projectSessionID, head, state, capabilities, error?}
  -> server validates sender+request+epoch+membership, marks executor ready
  -> MCP returns actual created/open/ready result (not just event was sent)
```

- `ready` “her feature sağlıklı” demek değildir: bozuk modelde de query/check çalışabilmelidir. Kernel başlangıç hatası, build'in tamamlanmış ama feature hatalı olması ve renderer bulunmaması ayrı durum/capability olmalıdır. Render isteyen tool ilgili renderer readiness'ini bekler; salt op kaydı ile browser executor hazır olma eşit değildir.
- Ready anlık bir gözlemdir; her call routing anında canlı connection/capability/branch tekrar doğrulanır. Gecikmiş `open_result` veya iptal sonrası ack ready'yi geri getiremez. Heartbeat TTL ve reconnect sonrası yeniden subscribe+replay+ack gerekir.
- Idempotency: `open_project` aynı workspace/proje için yeni sekme/worker üretmesin; eşzamanlı open istekleri tek entry promise'ini paylaşsın. `create_project` için opsiyonel idempotency key `{subject, tool, key}` düzeyinde saklansın; timeout sonrası tekrar çağırma ikinci proje doğurmasın.
- Bir browser call'u timeout'a düşerse commit'in yapılmadığını varsaymayın. Özellikle mutate çağrısını başka executor'da otomatik yeniden denemeyin; call/idempotency kaydı veya log durumu ile sonucu uzlaştırın. `status` sonucu “unknown/in-flight” durumunu taşıyabilsin.

#### Önerilen araç sözleşmeleri (tamamı yeni öneri)

| Araç | Temel girdiler | Sonuç / güvenlik |
|---|---|---|
| `list_workspaces` | isteğe bağlı filtre | Yalnızca caller'ın izin verdiği canlı workspace'leri, label/ID/durum/capability; başka kullanıcı adı/pencere bilgisi yok. |
| `workspace_status` | `workspace` | Aktif proje, açık entry'ler ve `opening/syncing/ready/degraded/suspended/error`, proje/dal/capability/son hata; byte ve metadata minimizasyonu. |
| `open_project` | `project`, `workspace?`, `activate?`, `wait_for?` | Request ID, seçilen workspace, proje/dal, açıldı/hazır/timeout; idempotent. `activate` app sekmesi seçimi, OS/browser odak çalma garantisi değil. |
| `close_project` | `project`, `workspace?` | Yalnızca hedef UI sekmesini kapatır, **projeyi silmez**. Bekleyen commit/agent varsa `busy` veya açık stop/drain politikası; tek executor kapatılırken anlaşılır uyarı. |
| `create_project` | mevcut name/description + `open: auto\|never\|required`, `workspace?`, `activate?`, idempotency key? | `created` ve `open/ready` ayrı; ID ve link her zaman oluşturma sonucuna bağlı. Hedef belirsizliğinde asla bütün browser'lara yayınlama. |
| mevcut `list_projects` | görünürlük/paging + isteğe bağlı `workspace` | Global `open_in_browser` yerine caller'ın hedef workspace'ine göre `open_here`, `ready_here`, capabilities; workspace dışı presence varsayılan verilmesin. |

- Kullanıcının beklediği otomatik açma için `open:auto` iyi varsayılan olabilir: tek uygun/bound workspace varsa aç, yoksa `created:true, opened:false, reason` dön; ID/linki kaybetme. `open:never` tamamen server-only davranışı korur. `required` için hedef/izin/kapasiteyi **oluşturmadan önce** çözün; buna rağmen sonradan UI koparsa oluşan projeyi sessiz silmeyin, partial success dönün. Create atomikliği ile UI readiness aynı transaction değildir.
- `start_proposal` durumu `{subject, mcpSessionID/author, projectID}` bazına taşınsın; `finish_proposal(project)` yalnızca o eşlemeyi kaldırsın. Bu görevde kullanıcı tarafından istenen “proje+yazar” izolasyonunun güvenli hali budur. Branch'in proje aidiyeti her kullanımda doğrulanmaya devam etsin.
- “proposal oluşturuldu” proje üyelerine bilgi olabilir; **otomatik branch-follow** yalnızca seçili workspace'e veya kullanıcının açıkça takip ettiği agent'a uygulansın. Başka editor'ların görünümlerini global Notify ile zorla değiştirmeyin. Proje açıldığında son proposal'ı otomatik takip etmek yerine sekmenin seçtiği dalı açıkça restore edin/isteyin.

### Gaps

- Bugün workspace registry, binding, readiness ack ve bu yeni araçlar yoktur. Yukarıdaki protokol MCP standardının otomatik sağladığı özellik değildir; Ket uygulama katmanı geliştirmesidir.
- Canlı yetki iptali mekanizması bu araştırmada uçtan uca denetlenmedi. Mevcut WS başta access kontrolü yapıyor; uzun ömürlü bağlantılarda revocation için ayrıca test gerekir.
- Çok düğümlü server deployment ve shared presence store kapsam dışıdır. İlk sürüm tek-process hub'a uygundur; yatay ölçek planlanırsa kullanıcıya bağlı event routing ve dağıtık idempotency tasarlanmalıdır.

## 3. Hangi editör örüntüleri alınmalı; uygulama aşamaları ve kabul ölçütleri neler?

### Takeaway

Hazır bir IDE framework'ü eklemek yerine Ket'in mevcut Session yapısı üzerinde küçük bir sekme yöneticisi ve kontrol düzlemi geliştirmek daha dar ve denetlenebilir değişikliktir. IDE'den alınacak ana fikirler “çalışma alanı ≠ belge”, açık kaynak/kimlik ayrımı ve scope görünürlüğüdür; hazır kodun kapsamı/lisansı ayrıca değerlendirilmelidir.

### Cited Findings

- VS Code multi-root workspace bir pencerede birden fazla proje klasörünü birlikte yönetir; workspace dosyası folder listesi ve workspace ayarları taşır, aynı isimli dosyalarda tab/Quick Open etiketleri klasörle ayrıştırılır, ayarların user/workspace/folder kapsamları ayrıdır. **Bu, Ket'te çok sayıda bağımsız CAD/PCB belgesini tek Doc'ta birleştirmek zorunluluğu anlamına gelmez.** — [VS Code resmi multi-root belgesi](https://code.visualstudio.com/docs/editor/multi-root-workspaces).
- ARIA Tabs Pattern bir seferde bir panel gösterir; `tablist/tab/tabpanel`, `aria-selected/controls/labelledby` ve ok tuşlarıyla gezinmeyi tanımlar. Otomatik aktivasyon yalnızca panel gecikmesiz gösterilebiliyorsa önerilir; yüklemesi geciken panelde Enter/Space ile manuel aktivasyon uygundur. — [W3C APG Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).
- Page Visibility API browser dokümanının visible/hidden durumunu bildirir; blur/focus bunun eşdeğeri değildir. Arka planda rAF durabilir, timer'lar kısıtlanabilir; CSS ile uygulama paneli saklamak browser dokümanını hidden yapmaz. Bu nedenle app sekmesi active durumu ile browser visibility ayrı ele alınmalıdır. — [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).
- VS Code kaynak deposunun lisansı **MIT**'dir ve kopyalanan yazılım/önemli bölümlerinde copyright ve izin metnini korumayı ister. Bu kaynak kod lisansıdır; Microsoft'un ürün markaları, paketlenmiş ürün dağıtımı veya her üçüncü parti bağımlılık için genel izin diye yorumlanmamalıdır. Bu araştırmada kod/asset kopyalanmadı, yeni bağımlılık önerilmiyor. — [Doğrudan LICENSE.txt](https://raw.githubusercontent.com/microsoft/vscode/main/LICENSE.txt).
- Ket command registry yalnızca `mutate/query` türlerini bilir; `apply` pure, dış dünya erişimi `prepare` içindir. Repository kuralı her capability'nin command + query/check/render doğrulamasıyla gelmesi ve command değişince `make gen` çalıştırılmasıdır. Öte yandan `list_projects/create_project/undo/...` zaten `tools.go` içinde server-only ayrı araçlardır; workspace açmayı sahte belge mutation'ı yapmak doğru değildir. — [Registry:1–6,117–145,174–179](../../_ui/src/engine/registry.ts), [AGENTS:5–18](../../AGENTS.md), [Tools:108–175](../../internal/mcpserver/tools.go).

### Inferences

#### Katalog ve deterministic replay kararı

- Yeni workspace komutları UI-only butonlar olmamalı; UI ve MCP aynı doğrulanan workspace action handler'ını kullansın, `workspace_status` gözlenebilir doğrulama sağlasın.
- **Önce kapsam ayrımını açıklaştırın:** registry/catalog için `scope: document|workspace|server` veya ayrı ama aynı üretilen katalogda birleştirilen workspace command tanımı ekleyin. Mevcut `kind:mutate|query` belgenin deterministik semantiği için aynen kalsın; side effect'li `open_project`ı belge `apply` içine sokmayın, sahte op yazmayın. Server-only araçların mevcut istisnasını sessiz büyütmek yerine generator/schema/tool açıklamalarını birlikte güncelleyin.
- `make gen` sonrası `internal/catalog/catalog.json`, MCP guide ve in-app agent scope'u tutarlı olmalı. In-app agent'ın başka proje sekmelerini kontrol etmesine varsayılan izin vermek gerekli değil; workspace araçları ScopeMCP/Shell'a sınırlandırılabilir. Modelleme komutları yine aynı registry'den ve aynı document apply/prepare yolundan geçmeli.

#### Aşama 1 — Yaşam döngüsü ve proje izolasyonu

Değişiklik alanları: `_ui/src/lib/kernel-client.ts`, `session.svelte.ts`, `account.svelte.ts`, `pages/Workspace.svelte`, `components/{Viewport,BoardView,SchematicView,Sidebar,Chat}.svelte`, `lib/scene.ts`.

- `KernelClient.dispose` + pending rejection + closed guard; Session aç/kapa/branch geçişinde iptal/generation; render callback sahipliği ve cleanup; proje-scoped izin ve chat state taşıma.
- Kabul: Editor A + Viewer B aynı anda açıkken B'de UI/mutate kapalı, A etkilenmiyor; B kapanınca A erişimi resetlenmiyor. İki projede aynı feature adı, seçim, undo ve chat draft birbirini etkilemiyor. Projeyi yüz kez aç/kapa testinde worker ve observer/event sayısı taban çizgisine dönüyor. Kapanan entry'nin geç tamamlanan fetch/build'i yeni entry'yi güncellemiyor.

#### Aşama 2 — Sekme Shell'i, router ve görünüm durumu

Yeni `_ui/src/lib/workspace.svelte.ts` ve `components/WorkspaceTabs.svelte` düşünülebilir; `_ui/src/App.svelte`, `lib/router.svelte.ts` ve `pages/Workspace.svelte` ownership ayrılır. Mevcut `#/p/<id>` deep link “o projeyi manager'da aç/aktif et” olur; başkasını kapatmaz. Liste/ayarlar Shell'in bir görünümü olur; açık Session'lar yaşamaya devam eder.

- Proje sekme etiketinde isim yanında gerektiğinde kısa ID; connection/build/error/proposal/busy durumu; kapat ile sil farklı kontrol. Başlangıçta docking, sürükleyerek pencereye ayırma veya split editor gerekmiyor.
- Aktif olmayan paneller inert/focus dışı; kendi UI active state'i ile rAF/klavye kapalı. Kamerayı, 2D pan/zoom'u ve modu switch sırasında sıfırlamama. Render tool'u pasif sekmede de doğrudan ilgili projeyi çizebilmeli.
- Kabul: A→B→A kamera/pan/seçim/draft korunur. Ctrl/Cmd+Z sadece aktif proje head'ini bir azaltır; F/M/Delete sadece uygun aktif viewport'ta çalışır. Normal Tab ile tablist'ten panele ulaşılır; ok tuşları/Enter/Space ve sekme kapatınca odak geri konumu W3C örüntüsüne uyar. Hash back/forward yeni worker üretmez. Browser refresh'te sadece geçerli kullanıcıya ait restore listesi açılır.

#### Aşama 3 — Kontrol WS'si ve güvenli registry

Yeni `internal/hub` workspace registry/kontrol mesajları ve `internal/server` workspace WS handler'ı; `server.go` route; UI manager kontrol client'ı; `internal/mcpserver/mcp.go` stable principal/session binding taşıma. Mevcut project hub JOIN/CALL'a explicit workspace association + readiness eklenir.

- Kabul: Sadece proje listesi açık browser'da dahi open isteği gelir. Aynı kullanıcı iki pencerede açıkken unbound çağrı ambiguity döner, yalnızca belirtilen/bound pencere değişir. Başka kullanıcının workspace ID'si bilinse dahi liste/get/open/close/ack reddedilir ve existence detayı sızmaz. Viewer session mutation executor'ı seçilmez. Aynı projeye erişen diğer kullanıcılar normal op sync alır ama özel kontrol/call event'i almaz. Sahte/expired/başka requestID ve eski epoch ack'i yok sayılır. Bağlantı kopması pending open/call'ı sonlandırır veya açık unknown durumuna geçirir; sessiz başka pencereye geçmez.

#### Aşama 4 — MCP araçları, proposal düzeltmesi, uçtan uca doğrulama

`internal/mcpserver/tools.go`, `tools_test.go`, `internal/hub` testleri ve katalog generator/guide; yeni UI integration/browser testleri. `proposals` için typed composite key kullanın; `finish_proposal(project)` ve targeted follow.

- Kabul: `create_project(open:auto)` → yeni app sekmesi → matching ready ack → aynı workspace/proje/dalda `box` veya basit PCB mutation → `query/check/render` ile doğrulama. Eski projenin head'i, seçimi ve kamera durumu değişmez.
- Browser yokken create bir kez olur, `created:true/opened:false` ve link döner; modelleme açık executor hatası verir. Cold WASM/renderer gecikmesinde komut ready öncesi çalışmaz. Kernel hatasında sahte ready dönmez; bozuk feature dokümanında query/check mümkün kalır. Aynı idempotency key ile timeout retry ikinci proje oluşturmaz.
- İki projede aynı MCP session ile iki proposal açılabilir; birini bitirmek diğerini bozmaz. Başka kullanıcının/izlenmeyen agent'ın proposed olayı kullanıcının dalını zorla değiştirmez. Main çağrısı proposal executor'ına düşmez.
- Busy sekme close, in-flight commit/call, kullanıcı yetkisi kaldırılması, logout, server restart, websocket reconnect, yavaş render ve render sırasında aktif tab değişimi test edilir. Mutation timeout sonrası otomatik yeniden yürütmeyle çift op oluşmadığı doğrulanır.
- Repo doğrulaması: `make gen`, `go vet ./...`, `go test ./...`, `_ui` içinde `pnpm check && pnpm test`; store testleri için `KET_TEST_DSN`. Browser test aracı mevcut değilse test altyapısı ayrı onayla seçilmeli; bu araştırma için paket kurulmadı.

### Gaps

- Bu bir uygulanabilir tasarım ve acceptance önerisidir; implementasyon veya çalışan demo değildir. Süre/işgünü, bellek limiti ya da performans kazanımı ölçülmedi.
- VS Code yalnızca kapsam/etiketleme örüntüsüne referanstır; aynı ürün davranışının Ket'e birebir uygunluğu veya hazır bir tab library'sinin gerekliliği iddia edilmiyor.
- Kaynakların erişildiği hali değerlendirildi; hareketli `main` lisans linki yeniden kullanım yapılacağı commit için tekrar doğrulanmalı. Hiçbir UI framework/IDE kodu bu çalışma kapsamında yeniden kullanılmadı.
