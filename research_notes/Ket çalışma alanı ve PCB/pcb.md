# Ket: ileri PCB iş akışları ve yeniden kullanılabilir açık kaynak bileşenler

Doğrulama tarihi: **10 Kasım 2026** (bu oturumda yerel kaynak ve aşağıdaki resmî kaynaklar okundu). Bu bir sürüm çıkış tarihi veya gelecekteki özellik vaadi değildir. KiCad davranışları için özellikle **9.0 kılavuzu** esas alındı; canlı geliştirme belgelerindeki daha yeni sürüm ifadeleri kurulmuş/kararlı özellik sayılmadı. Uygulama değiştirilmedi, paket kurulmadı, dış program veya test çalıştırılmadı.

## 1. Ket gerçekten nerede; hangi yetenekleri tekrar geliştirmemeliyiz?

### Sonuç

Ket bir PCB görüntüleyicisi değil; belge/komut tabanlı bir PCB–mekanik tasarım sistemi. Eksik halka yeni bir netlist, pour, şema veya 3D motoru değil; mevcut çekirdeğin gelişmiş kurallara, etkileşimli bakır düzenlemeye ve bağımsız doğrulamaya açılmasıdır.

### Kanıtlı bulgular: yerel kaynaklar

| Mevcut yetenek | Gerçek uygulama ve kanıt |
|---|---|
| Kart, gerçek parçalar, netler, sınıflar, yollar ve vialar | [`commands.ts`](../../_ui/src/engine/pcb/commands.ts): `set_board`, `find_parts`, `part_info`, `add_component`, `move_component`, `connect`, `set_net_class`, `add_track`, `add_via`, `unroute`. [`board.ts`](../../_ui/src/engine/pcb/board.ts) bunları ortak `ResolvedBoard` geometrisine çözüyor. |
| LCSC/EasyEDA ve 3D model önbelleği | [`internal/parts/parts.go`](../../internal/parts/parts.go): parça arama/indirme, PostgreSQL cache, UUID doğrulamalı OBJ model proxy; BOM teklif/stok sorguları da mevcut. Yeni parça servisi veya genel model indirme servisi önermek tekrardır. |
| Gerçek autorouting | [`specctra.ts`](../../_ui/src/engine/pcb/specctra.ts) DSN üretip SES okuyor; [`internal/parts/router.go`](../../internal/parts/router.go) Java/Freerouting subprocess çalıştırıyor. `autoroute.prepare` sonucu op argümanlarına koyuyor, `apply` yalnız belgeyi değiştiriyor. |
| Copper pour ve bağlantı analizi | [`zones.ts`](../../_ui/src/engine/pcb/zones.ts), [`poly.ts`](../../_ui/src/engine/pcb/poly.ts), [`drc.ts`](../../_ui/src/engine/pcb/drc.ts): clearance, thermal bağlantılar, ada temizliği; ratsnest ve DRC dolgu bağlantılarını hesaba katıyor. |
| Üretim ve DRC | [`fab.ts`](../../_ui/src/engine/pcb/fab.ts): Gerber X2, Excellon, BOM, CPL; `export_fab` DRC/bağlantı hatalarında varsayılan olarak duruyor. `drc.ts` üretici sabitleriyle genişlik, clearance/short, edge, delik, courtyard ve bağlantı kontrolü yapıyor. |
| Şema çizimi ve düzenlenmesi | [`sch-draw.ts`](../../_ui/src/lib/sch-draw.ts), [`schematic.ts`](../../_ui/src/engine/pcb/schematic.ts), `wire_pins`, `remove_wires`, `rename_net`, `place_symbol`, `render_schematic`: saklanan kırılma noktaları, ortogonal yollar, net birleştirme/ayırma mevcut. |
| Kart–kutu ve 3D | [`README.md`](../../README.md): sketch kaynaklı outline/cutout, parametrik kart boyutu ve Z; `board` ve `part_<REF>` gövdeleri üzerinden inside/min-distance/no-overlap/boolean iş akışı; gerçek parça modelleri ve STEP detay çıktısı mevcut. |
| Görsel PCB arayüzü | [`BoardView.svelte`](../../_ui/src/components/BoardView.svelte): pan/zoom, top/bottom görünüm, courtyard hit-test ile komponent seçimi, BOM ve routing durumu. Pointer drag şu an bakırı itmek veya parça taşımak yerine görünümü kaydırıyor; bu dosyada etkileşimli router bulunmuyor. |
| Testler | [`pcb.test.ts`](../../_ui/tests/pcb.test.ts): gerçek parça fixture'larıyla USB-C→LDO kartı, net alias'ları, DRC, manuel routing, DSN/SES sayısal örneği, fab, pour, vendor STEP, şema kablosu/net ayrılması, BOM ve parametrik outline. Test route servisi bilerek `no router in tests` hatası veriyor: canlı Freerouting uçtan uca testi olduğunu iddia edemeyiz. |

### Çıkarımlar: gerçek boşluklar

- **Katman sayısı stackup değildir.** [`doc.ts`](../../_ui/src/engine/doc.ts) ve `ResolvedBoard.layers` yalnız `2 | 4`; bakır/dielektrik kalınlığı, malzeme, epsilon_r, kayıp tanjantı, referans düzlem veya bölgesel stackup modeli yok. `NetClass` genişlik/clearance/via ölçülerini zaten içeriyor; bunları yeniden kurmak değil geliştirmek gerekir.
- **Via var, via-span yok.** Mevcut `Via` net/konum/drill/diameter içeriyor; DRC tüm bakır katmanlarını bağlı kabul ediyor. Blind/buried/microvia eklemeden önce bağlantı analizi, pour ve fab birlikte değiştirilmelidir.
- **Diferansiyel çift, length/skew hedefi ve shove boşlukları** incelenen belge/komut modelinde bulunmadı. Bunlar bağımsız iki `add_track` çağrısına indirgenemez: birlikte düzenleme, ölçüm ve ihlal raporu gerekir.
- **JLCPCB profili genel DFM garantisi değil.** `rules: 'jlcpcb'` ve `drc.ts` sabitleri mevcut; üretici+teknoloji+katman sayısı+bakır ağırlığına göre sürümlü profil, mask sliver/paste, slot, kontrollü empedans ve assembly varyantlarının tamamını doğruladığı gösterilmedi. `fab.ts` PTH/NPTH delikleri yorumlarla tek dosyada yazıyor; bunu bütün üreticiler için yeterli kabul etmemek gerekir.
- **Özet query doğruluk kaynağı olmamalı.** `get_board` konum/bbox değerlerini 0,01 mm'ye yuvarlıyor. Dönüştürme ve roundtrip karşılaştırması özet JSON üzerinden değil, tam çözülmüş belge/geometri üzerinden yapılmalıdır.

### Açık noktalar

İnceleme statiktir; mevcut testlerin geçtiği, büyük kart performansı veya fab çıktılarının fiziksel üretimle doğrulandığı iddia edilmiyor. Yaylı outline'lar `loopToPoly` içinde tessellate ediliyor; dış alışverişte gerçek yay koruma kapsamı ayrıca kararlaştırılmalı.

## 2. Hangi projeden neyi, hangi lisans ve entegrasyon sınırıyla almalıyız?

### Sonuç

**İlk tercih:** mevcut Freerouting köprüsünü sağlamlaştırmak ve KiCad dosya alışverişi + sandbox içindeki `kicad-cli` doğrulayıcısını eklemek. **Doğrudan kütüphane tercihi:** yalnız dar kapsamı testle kanıtlanmış TypeScript dönüştürücüler/veri şemaları. KiCad/LibrePCB GPL çekirdeklerini MIT Ket'e kopyalamak veya WASM'e çevirip sorunsuz bir bağımlılık gibi paketlemek önerilmiyor.

### Kanıtlı bulgular ve sıralama

| Öncelik / bileşen | Tam lisans ayrımı | Önerilen kullanım | Sınır / karar |
|---|---|---|---|
| **1 — KiCad `kicad-cli`** | KiCad programının çoğunluğu **GPL-3.0-or-later**; üçüncü taraf dosyaların lisansları ayrıca değişebilir. KiCad kütüphanelerinin lisansı bununla aynı değildir. [Resmî lisans](https://www.kicad.org/about/licenses/) | Ayrı süreç + `.kicad_pcb`/proje dosyası alışverişi; JSON DRC, bağımsız Gerber/drill/placement, IPC-D-356, STEP/BREP, gerekirse IPC-2581/ODB++ çıktısı. [CLI](https://docs.kicad.org/9.0/en/cli/cli.html) | Mevcut `export_fab` yerine zorunlu ikinci exporter değil, önce doğrulama ve karşılaştırma aracı. KiCad DRC **Ket'in Gerber'ini doğrudan denetlemez**; dönüştürülmüş KiCad modelini denetler. |
| **2 — Mevcut Freerouting** | İncelenen **v2.5.0 `LICENSE`: GPL v3**; bunu MIT veya lisansı doğrulanmış bağımsız bir JS routing paketi diye sunmamak gerekir. [Resmî sürüm ağacı; LICENSE ve README](https://github.com/freerouting/freerouting/tree/v2.5.0) | Var olan Java subprocess + DSN/SES sınırını koru. Korunan bakır, net class/via ölçüleri, keepout, başarısızlık ve sonuç doğrulamasını güçlendir. | Yeni autorouter eklemek gereksiz. Batch autoroute'u tarayıcıda düşük gecikmeli shove ile eşitlemeyin. DSN/SES'in elektromekanik proje/şema/proje kurallarının tamamını taşıdığı varsayılmamalı. |
| **3 — KiCad IPC + resmî `kicad-python`** | KiCad sunucusu GPL-3.0-or-later; ayrı **`kicad-python` istemcisi MIT** (LICENSE metni doğrudan kontrol edildi). [Python lisansı](https://gitlab.com/kicad/code/kicad-python/-/raw/main/LICENSE) | Kullanıcıda çalışan yerel companion köprüsü: açık KiCad kartında desteklenen okuma/değiştirme ve kontrollü delta aktarımı. [IPC eklenti geliştirici belgesi](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/) | KiCad 9/10 için GUI gerekir; headless export/işlem sunucusu gibi tasarlamayın. Canlı belge 11 için ek yeteneklerden söz ediyor; burada onların kararlı/kurulu olduğu varsayılmadı. IPC'nin bir `route_with_shove()` servisi verdiği doğrulanmadı. |
| **4 — `kicad-converter` (npm adı tam olarak bu; `@tscircuit/kicad-converter` değil)** | Resmî repodaki **LICENSE: MIT**. [Repo: LICENSE, `lib/kicad-pcb`, testler](https://github.com/tscircuit/kicad-converter) | Parser/serializer parçaları, dar kapsamlı adaptör ve fixture öğrenimi için **koşullu doğrudan TS yeniden kullanım**. | Kaynak README'den daha dar: `lib/index.ts` yalnız PCB/pro dışa aktarıyor. PCB importunda komponent üretimi yorumda; pad konumu footprint rotasyonu uygulanmadan toplanıyor; exportta via `net: 0` TODO'su, sabit 2-katman listesi, dönüşüm/ofset ve rastgele ID üretimi var. Komple, kayıpsız KiCad↔Ket köprüsü değildir. |
| **5 — `circuit-json-to-gerber` (npm adı tam olarak bu)** | **MIT**, hem package.json hem LICENSE kontrol edildi. [Repo: README, LICENSE, package.json](https://github.com/tscircuit/circuit-json-to-gerber) | `convertCircuitJsonToGerberFiles` ve ayrı plated/unplated drill çıktıları: fab fixture'larında ikinci uygulamayla karşılaştırma; belirli eksik çıktı için aday. | Ket'te Gerber zaten var. Sadece yeni exporter üretmek değer değil; adaptörün net/pad/pour/geometri kaybetmediği kanıtlanmalı. İki exporter'ın anlaşması resmî CAM/DFM onayı değildir. |
| **6 — `circuit-json`** | **ISC**; package.json ve LICENSE birbirini doğruluyor. [Repo: LICENSE ve şema tanımları](https://github.com/tscircuit/circuit-json) | tscircuit adaptör sınırında tip/şema; Ket `Doc` ve komut kaydının yerine geçirilmemeli. | `circuit-json` lisansı ile tscircuit altındaki her repo'nun lisansını karıştırmayın; transitif bağımlılıklar ve pinlenen sürüm ayrıca denetlenir. |
| **7 — LibrePCB uygulaması / resmî kütüphaneleri** | Uygulama kaynak kodu **GPLv3**; **resmî parça kütüphaneleri CC0-1.0**. Üçüncü taraf kütüphaneler için bu genelleme yapılamaz. [Resmî lisans ayrımı](https://librepcb.org/license/) | Parça–symbol–package–device ayrımı, UUID kimliği, assembly varyantları ve output job modeli için tasarım öğrenimi; CC0 resmî parçalar için dönüştürülmüş alternatif veri kaynağı adayı. | C++ çekirdeği doğrudan tarayıcı kütüphanesi olarak önermiyorum. `librepcb-cli open-project --erc --drc --run-jobs` **LibrePCB projesi** üzerinde çalışır; Ket JSON/Gerber için evrensel denetleyici değildir. [CLI](https://librepcb.org/docs/cli/open-project/) İkinci büyük proje formatı köprüsü ilk fazda maliyetlidir. |

**Önemli KiCad farkları — öğrenilecek model, kopyalanacak GPL kod değil:** KiCad PCB Editor resmî kılavuzu push-and-shove/walkaround/highlight-collisions, diff-pair routing, length ve skew tuning, fiziksel stackup ve özel kuralları belgeliyor. Net class track/via değerleri varsayılan/optimal değerlerdir, tek başına min/max DRC kısıtı değildir. Diff-pair optimal gap de min/max gap ihlali kontrolünü kendiliğinden açmaz. Bu ayrım Ket'in bugünkü non-default class track genişliğini minimum sayan davranışıyla semantik olarak aynı değildir. [KiCad PCB Editor 9.0](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html)

**Dosya formatı sınırı:** `.kicad_pcb` S-expression; stackup, layer span/type içeren via, segment/arc, net, footprint ve zone tanımları var. Net class/kuralları yalnız board dosyasında var sanmayın: proje ayarları ve `.kicad_dru` birlikte ele alınmalı. Üçüncü taraf üreticide `generator ket` kullanılmalı. Sayfadaki eski örneği güncel formatın normatif fixture'ı sanmayın. [PCB formatı](https://dev-docs.kicad.org/en/file-formats/sexpr-pcb/), [özel kurallar ve proje dosyaları](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html#custom-design-rules)

**Şematik alışverişi ayrı iş:** `.kicad_sch` içinde `lib_symbols`, junction/no_connect, wire/bus, yerel/global/hiyerarşik etiket, UUID ve instance path bulunur. Ket'in mevcut şemasını yeniden yazmak yerine ileride bunları açık kayıp raporuyla eşlemek gerekir. Görünümün benzediğini göstermek elektriksel eşdeğerlik kanıtı değildir. [Şema formatı](https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/)

### Çıkarımlar: önerilen mimari

1. **MIT/ISC veri ve yardımcı kütüphane:** sürüm+commit sabitle, lisans/notice koru, bundle ve transitif lisans incelemesi yap. `kicad-converter` için doğrudan “tak ve kullan” değil, adaptör contract-test kapısı şart.
2. **GPL uygulama:** bağımsız dosya protokolü ve subprocess/yerel companion, çekirdeği Ket içine linklemekten daha uygun mühendislik sınırı. Bu sınır otomatik hukuk muafiyeti değildir; dağıtılan JAR/binary/container için ilgili GPL kaynak/notice yükümlülükleri ayrıca değerlendirilir. Ket'in [`LICENSE`](../../LICENSE) dosyası MIT; GPL kodu MIT diye yeniden etiketlemek kabul edilmez.
3. **Etkileşimli routing:** en hızlı ileri seviye iş akışı, KiCad GUI'de shove/diff-pair düzenleyip kontrollü delta geri almak; ilk aşamada web içi KiCad router portu değil. Tarayıcı içi routing zorunluysa ayrı bir ürün yatırımı: stabil item kimlikleri, route preview, commit/cancel, lock, yürürlükteki kural sorgusu ve shove ile değişen bütün bakırın tek atomik komutla kaydı gerekir.
4. **Kopyalanmadan öğrenme:** davranış/format/fixture ve kullanıcı akışı incelenebilir; GPL algoritma implementasyonunu TS'ye çevirmek veya WASM'e derlemek lisans sorununu ortadan kaldırmaz. Horizon bu dar kapsam için gerekli değil; ikinci GPL masaüstü çekirdeğini entegrasyon adayı olarak eklemek yerine önce KiCad köprüsünü kanıtlamak daha yüksek getirili.

### Açık noktalar ve güven düzeyi

- Lisans metinleri ve yukarıdaki mevcut kaynak davranışı yüksek güvenli; gerçek cihaz/CLI denemesi yapılmadığı için uçtan uca entegrasyon ve kalite/performans iddiaları yok.
- `kicad-converter` README şema API'sini anlatıyor ancak mevcut ana export ve uygulama bunu bütünüyle doğrulamıyor; README vaadi yerine kod/test kapsamı esas alınmalı. Verilen sorunlar incelenen `main` içindir, tüm gelecek sürümler için iddia değildir.
- Çalışan bir OSS browser shove kütüphanesi veya resmî KiCad IPC shove endpoint'i bu araştırmada doğrulanmadı. Freerouting'in batch kalitesinden diff-pair/controlled-impedance garantisi çıkarılamaz.
- EasyEDA/LCSC verisi ve vendor 3D modelinin yeniden dağıtım izni, proxy kodunun veya Ket'in MIT lisansından türemez; ayrı veri lisansı/servis koşulu incelemesi gerekir.

## 3. Hangi fazlar, sayısal kabul ölçütleri ve güvenlik kapılarıyla ilerlemeli?

### Sonuç

Aşağıdakiler uygulanmış özellikler veya ölçülmüş performanslar değil, **önerilen kabul sözleşmesidir**. Her faz mevcut komut registry'si ve deterministik op-log üzerine kurulur; yeni yetenek bir komut ve query/check/render doğrulamasıyla gelir. Network/CLI işleri `prepare` veya query servisinde, kalıcı değişiklikler yalnız saf `apply` içinde tutulur. [`AGENTS.md`](../../AGENTS.md)

### Kanıta dayanan sınırlar

Mevcut DSN ihracı `(resolution um 1)` ve `round(mm*1000)` kullanıyor; alt yüz Specctra `back`, mevcut bakır `protect`. SES okuyucu um/mm/mil/inch çözünürlüğünü dönüştürüp 0,001 mm'ye yuvarlıyor; tanınmayan netleri atlıyor, tanınmayan via adına varsayılan 0,3/0,6 mm ölçüsü veriyor ve layer'ı TypeScript cast ile geçiriyor. Bunlar genişletilecek test/validasyon noktalarıdır; sadece dosya parse edilmesi başarı değildir. [`specctra.ts`](../../_ui/src/engine/pcb/specctra.ts)

`router.go` süre sınırı, tek-job mutex, geçici dizin ve telemetry kapatma içeriyor; fakat bu bir OS sandbox değil. İndirme kontrolü HTTP status ve minimum boyuta dayanıyor, digest doğrulaması yok; stdout/stderr sınırsız `bytes.Buffer`, SES dosya okuma sınırı yok. İşlem hata verse bile SES dosyası varsa sonuç dönebiliyor. Bunlar doğrulanmış kod gözlemleridir; sömürü kanıtı değildir. [`router.go`](../../internal/parts/router.go)

KiCad CLI JSON DRC ve `--exit-code-violations` sunuyor; belgelenen ihlal çıkış kodu 5, temiz sonuç 0. Bu, subprocess başarı kodu ile “kart temiz” sonucunu ayırmak için kullanılabilir. [CLI](https://docs.kicad.org/9.0/en/cli/cli.html#pcb_drc)

### Çıkarımlar: fazlar ve kabul sözleşmesi

| Faz | Önerilen iş | Somut kabul ölçütü |
|---|---|---|
| **0 — Referans ve güvenlik** | Şimdiki PCB yeteneklerini koruyan fixture corpus; router/toolchain kimliği; subprocess izolasyonu. | 2/4 katman, üst/alt parça, asimetrik footprint, döndürülmüş pad, polygon pad, cutout, pour, negatif koordinat, PTH/NPTH fixture'ları; her artifact'ta belge hash'i + tool sürümü/digest + rules-profile sürümü. Timeout, cancel, kötü dosya, kısmi SES ve oversized çıktı testleri. |
| **1 — DSN/SES sağlamlaştırma** | Yeni autorouter yerine mevcut aktarımı doğrula; gerekirse `export_dsn`/`import_ses` komutları ve `check_interchange` query'si. | um/mm/mil/inch ve farklı resolution için tablo testleri; net üyeliği/layer/via ölçüsü korunur; mevcut protected bakır değişmez ve iki kez eklenmez. Kaynak ile roundtrip noktası arasında **≤0,001 mm** hedef hata; kuantalama sınırını aşan dönüşüme açık hata. Tanınmayan via/layer/unit, NaN/Infinity, negatif width/drill, çap≤drill ve bilinmeyen net sessiz varsayılan değil teşhis üretir. Importtan sonra kısa devre/bağlantı ve DRC yeniden çalışır. |
| **2 — KiCad dosya köprüsü + bağımsız kontrol** | Önce dar ihracat: tam footprint/pad, net, track/via, outline/cutout, zone, temel kurallar; sonra kontrollü import. `.kicad_pro`/`.kicad_dru` kaybını açıkla. | Hedef KiCad major sürümünde CLI ile açılır; JSON DRC raporu oluşur. UUID/ref/pin/net/layer/top-bottom aynalama korunur; asimetrik alt yüz parçası 0/90/180/270 ve serbest rotasyonlarda sayısal doğrulanır. Desteklenmeyen arc/custom-pad/zone/rule varsa import reddi veya açık kayıp listesi; sessiz veri düşürme yok. Aynı dosyayı tekrar import etmek geometri/kimlik üretmez. |
| **3 — Stackup, kurallar, via span ve çiftler** | `set_stackup`, genişletilmiş `set_net_class`, `set_rule`, `set_diff_pair`, `measure_net`/`check_rules` gibi registry yetenekleri; bunlar önerilen adlardır. | Geriye uyumlu 2/4 model göçü; daha çok katman yalnız bütün pipeline desteklediğinde. Stackup toplamı thickness ile tutarlı; min/opt/max ve rule önceliği açıklanabilir. Via için type/from/to ve üretici izinleri; ortak katmanı olmayan bakır üzerinden sahte bağlantı yok. Çiftte gap, uncoupled uzunluk, toplam yol ve skew ölçülür; katman değişiminde gerçek via Z uzunluğu hesaba katılır. Empedans hedefi saklamak, EM çözücü/üretici stackup onayı olmadan “empedans doğrulandı” sonucunu üretmez. |
| **4 — Shove/drag ve senkronizasyon** | Önce KiCad'de ileri düzenleme + delta geri alma; webde gerekiyorsa ayrı etkileşimli routing prototipi. | Onaydan önce belge değişmez; Esc/cancel sıfır op; commit bütün eklenen/değişen/silinen copper'ı **tek atomik işlemde** kaydeder. Locked track sabit kalır, minimum clearance korunur, undo/redo ve offline op-log replay aynı sonucu verir. Önerilen performans bütçesi: tanımlı referans kart/donanımda preview p95 <50 ms; ölçülmeden vaat edilmez. |
| **5 — Kart–kutu ve üretim çıkış kapısı** | Mevcut outline/part-body sistemine fiziksel constraint ve dış-delta uzlaştırma ekle; üretim manifest'i ve bağımsız output kontrolü. | Aynı parametrik değişiklik outline, cutout, montaj deliği, stand-off ve connector açıklığını birlikte günceller veya açık conflict verir. Alt yüz dönüşümü + board Z/thickness için bbox, min-distance ve çakışma fixture'ları; eksik 3D model için conservative envelope/uyarı. Son onaydan sonra bakır değişirse routing/DFM raporu invalid olur. |

**Faz 2 için sayısal roundtrip örneği:** kaynağı `(x,y)=(−12,345; 7,891) mm` olan alt yüz, 90° döndürülmüş asimetrik pad fixture'ı seçin; Ket→KiCad→Ket sonrası yalnız komponent merkezi değil **tüm world-pad köşelerini**, pad numarasını, net üyeliğini, layer ve drill/slot yönünü karşılaştırın. Farklı formatların Y yönü, bottom mirror ve placement origin dönüşümleri tek adaptör tablosunda tanımlanmalı. Gerber 4.6, Excellon 3 ondalık, DSN 1 µm hassasiyetlerini karıştırıp fazla hassasiyet varmış gibi raporlamayın. Alt yüz CPL rotation/origin sözleşmesini gerçek assembly profiline göre ayrıca doğrulayın. [`geometry.ts`](../../_ui/src/engine/pcb/geometry.ts), [`specctra.ts`](../../_ui/src/engine/pcb/specctra.ts), [`fab.ts`](../../_ui/src/engine/pcb/fab.ts)

**CLI sandbox kabulü:** allowlist executable + sabit argv (`exec.CommandContext`, shell string yok); işi yapan kullanıcı ayrı ve düşük yetkili; job dışı dosyalar read-only/erişilemez; network kapalı; CPU/RAM/PID/duvar-saati ve stdout/stderr/output boyutu sınırı; child-process grubu sonlandırma; symlink/path traversal ve arşiv bombası kontrolü; modeller/haricî dosya referansları için job-kökü allowlist; pinlenen binary/JAR checksum. OS/container sınırı gerçek izolasyon sağlar; sadece geçici çalışma dizini ve timeout yeterli değildir. İstemcinin verdiği executable/model yolu doğrudan çalıştırılmamalı. IPC socket/token uzak çok-kiracılı API'ye açılmamalı.

**Üretim doğrulaması üç ayrı kapı olmalı:**

1. **Model DRC/ERC:** Ket kontrolü + KiCad'e dönüştürülmüş modelin bağımsız DRC'si; elektriksel pin türleri/şematik eşlemesi varsa ERC/parity. Üretilmemiş tam `.kicad_sch` için `--schematic-parity`/ERC varmış gibi davranmayın.
2. **Artifact kontrolü:** gerçekten gönderilecek Gerber/Excellon/CPL/BOM tekrar okunur; copper ve drill bbox, layer sayısı, polarite/delikler, PTH/NPTH ayrımı, slot, mask/paste, birim/origin, komponent sayısı ve net test verisi karşılaştırılır. Sadece string header snapshot'ı veya PNG benzerliği yeterli değil. `circuit-json-to-gerber` bir karşılaştırma uygulamasıdır; tek başına artifact parser/DFM onaylayıcısı değildir.
3. **Üreticiye özgü DFM + insan onayı:** profili ve tarihini kaydet; kontrollü empedans/stackup, drill teknoloji limitleri, assembly yönü ve CAM sonuçlarını açıkça onaylat. `force` ile üretim ihracı varsa manifest'te hata/waiver/reviewer görünür olmalı; “DRC temiz” ifadesi üretim garantisi olmamalı.

**Deterministik entegrasyon:** dış router/IPC/CLI sonucu `source_doc_hash`, format/tool version ve doğrulanmış somut delta ile saklanır. Arada başka op varsa stale sonuç otomatik append edilmez; conflict/rebase/onay gerekir. Replay sırasında Java/KiCad çalıştırılmaz, network çağrılmaz ve rastgele ID üretilmez. Yeni komutlardan sonra `make gen`; uygulanacak değişikliklerde `go vet ./...`, `go test ./...`, `_ui` içinde `pnpm check && pnpm test` ve ilgili interchange fixture'ları kapı olur. [`AGENTS.md`](../../AGENTS.md), [`autoroute.prepare/apply`](../../_ui/src/engine/pcb/commands.ts)

### Açık noktalar / sonraki araştırma

Gerber/Excellon yeniden okuma için seçilecek bağımsız parser'ın lisansı ve kapsamı bu turda doğrulanmadı; belirli bir paketi önerilmiş saymayın. Canlı KiCad IPC routing yetenekleri, netclass özel-kural eşlemesi, gerçekten pinlenecek sürümler ve büyük kart benchmark'ı küçük bir uyumluluk deneyi gerektirir. Bu not, mevcut uygulamanın yerine yeni EDA yazmayı değil, **dosya/komut sözleşmelerini ve kalite kapılarını olgunlaştırmayı** önceliklendirir.
