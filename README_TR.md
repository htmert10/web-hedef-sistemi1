# Web Hedef Sistemi — MVP 0.1

Bu proje iki web ekranından oluşur:

- `/tablet`: telefon/tablet kamerası ve mikrofonu
- `/dashboard`: laptopta dijital hedef, puan, ortalama ve grupman

## Ne çalışıyor?

- Kamera ve mikrofon izni
- 1x–4x dijital kamera yakınlaştırma
- Hedefin dört köşesini elle seçme
- Perspektif düzeltme
- Temiz hedef referansı
- Özel ses için basit ses seviyesi öğrenme
- Olaydan önce/sonra görüntü karşılaştırma
- Yeni koyu deliğe benzeyen bölgeyi bulma
- WebSocket ile anlık koordinat gönderme
- Puan, toplam, ortalama ve en geniş grupman
- Son atışı silme ve seriyi sıfırlama
- Üst üste/şüpheli durumda öneri veya elle konum seçme

## Önemli gerçekçilik notu

Bu bir ilk prototiptir. Değişen ışık, telefonun oynaması, kâğıdın sallanması,
eski deliklerin yırtılması ve hedef baskı farkları hatalı algılamaya yol açabilir.
Gerçek doğruluğu görmek için kontrollü şekilde boş kâğıt üzerinde test edilmelidir.
Resmî puanlama yerine geçmez.

## En kolay kurulum: Render ile HTTPS

Tarayıcıların telefon kamerası ve mikrofonu için HTTPS istemesi nedeniyle ilk test
için HTTPS sağlayan bir sunucu kullanmak kolaydır.

1. Bu klasörü GitHub deposuna yükle.
2. Render'da `New > Blueprint` seç.
3. Depoyu bağla. `render.yaml` otomatik okunur.
4. Oluşan HTTPS adresini laptopta aç.
5. Laptopta `/dashboard`, telefonda `/tablet` sayfasını aç.

Örnek:
- `https://proje-adin.onrender.com/dashboard`
- `https://proje-adin.onrender.com/tablet`

Telefon görüntüsü sunucuya yüklenmez. Görüntü işleme telefonda yapılır;
sunucuya sadece atış koordinatı, güven ve durum gönderilir.

## Bilgisayarda yerel test

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Laptop:
- `http://localhost:8000/dashboard`

Telefon:
- `http://BILGISAYAR_IP:8000/tablet`

Not: Telefon tarayıcısı yerel HTTP adresinde kamera/mikrofonu engelleyebilir.
Bu durumda HTTPS kullanmak gerekir. Sadece laptop localhost testi için HTTP yeterlidir.

## Kullanım sırası

1. Telefonu sabitle.
2. Kamera ve mikrofonu aç.
3. Hedef köşelerini sırayla seç.
4. Hedefte yeni delik yokken temiz referansı kaydet.
5. Test sesini öğret.
6. Sistemi hazırla.
7. Önce ekrandaki `Test tetikle` düğmesiyle görüntü algılamasını dene.
8. Şüpheli durumda düzeltilmiş hedefe dokunarak elle konum seç.

## Sonraki teknik geliştirmeler

- Kareler arası otomatik hizalama
- Işık değişimi dengeleme
- Daha iyi ses sınıflandırması
- Birden fazla oturum/eşleştirme kodu
- Ayarlanabilir hedef ölçüsü ve puan kalibrasyonu
- Kalıcı seri kaydı ve CSV/PDF dışa aktarma
- PWA çevrimdışı çalışma


## Zoom notu

Zoomu hedef köşelerini seçmeden önce ayarla. Zoom değiştirilirse köşe kalibrasyonu ve temiz referans otomatik sıfırlanır.


## Hedef merkezi kalibrasyonu

Kâğıt hedeflerde nişan merkezi çoğu zaman kartın geometrik ortasında değildir. Bu sürümde temiz hedef kaydedildikten sonra “Hedef merkezini seç” düğmesine basılır ve düzeltilmiş görüntüde 10 halkasının tam ortasına dokunulur. Atış koordinatları bu noktaya göre yeniden merkezlenir; böylece 9 bölgesindeki bir işaretin 7 olarak hesaplanması önlenir.


## Halka referansı kalibrasyonu

Yeni kullanım sırası:

1. Hedefin dört köşesini seç.
2. Temiz hedefi kaydet.
3. 10 halkasının tam merkezine dokun.
4. 9 halka çizgisinin bir noktasına dokun.
5. 8 halka çizgisinin bir noktasına dokun.
6. 7 halka çizgisinin bir noktasına dokun.
7. Sistem kalan halkaları otomatik hesaplar.

Kalibrasyon kutusunda üç seçimin piksel yarıçapları ve tahmini hata kalitesi gösterilir.
Merkezden uzaklık sırası `9 < 8 < 7` değilse sistem kalibrasyonu kabul etmez.


## Beş noktalı konum kalibrasyonu

Bu sürüm tek bir halka yarıçapına göre büyütme yapmak yerine 5 referans noktası kullanır:

1. Hedef merkezi
2. Dış siyah dairenin üst kenarı
3. Dış siyah dairenin sağ kenarı
4. Dış siyah dairenin alt kenarı
5. Dış siyah dairenin sol kenarı

Bu noktalardan 2B affine dönüşüm hesaplanır. Böylece merkez kayması, dönme, yatay/dikey ölçek farkı ve hafif yamulma birlikte düzeltilir. Kalibrasyondan sonra düzeltilmiş hedefte çizilen mavi halkaların basılı halkalarla çakışması gerekir.


## Güvenli kalem noktası / etiket algılama sürümü

Bu paket, kâğıt üzerine sonradan eklenen kalem noktası, renkli/siyah etiket veya
benzeri güvenli görsel değişiklikleri algılamak için düzenlenmiştir.

Yeni algılama motoru:

- Referansı ve yeni görüntüyü 5 karelik zamansal medyanla oluşturur.
- Küçük X/Y kamera kaymalarını ±6 piksel içinde hizalar.
- `cv.absdiff` ile hem açılmayı hem koyulaşmayı algılar.
- Otsu eşikleme ve morfolojik opening uygular.
- Alan, dairesellik, en-boy oranı ve doluluk oranıyla uzun halka/çizgi
  parazitlerini eler.
- Güven skoru üretir.
- Güven %58 altındaysa veriyi otomatik göndermez; en iyi üç adayı gösterir ve
  manuel onay ister.

### OpenCV.js

Telefon/tablet sayfası OpenCV.js dosyasını resmi OpenCV CDN'inden yükler.
İlk açılışta internet bağlantısı gerekir. Tarayıcı eski JavaScript'i önbellekten
getirirse sekmeyi kapatıp yeniden açın.

### Test sırası

1. Kamerayı açın.
2. Dört köşeyi seçin.
3. Görüntü sabitken temiz referansı kaydedin.
4. Merkez ve dört yönlü halka kalibrasyonunu tamamlayın.
5. Kâğıda güvenli bir kalem noktası veya etiket ekleyin.
6. `Test tetikle` düğmesine basın ya da öğretilen sesi kullanın.
7. Güven düşükse ekrandaki adaylardan birini onaylayın veya konumu elle seçin.

Hiçbir kamera sistemi için %100 doğruluk garantisi verilemez. Bu sürüm,
düşük güvenli sonuçları otomatik göndermeyerek yanlış pozitifleri azaltır.


## Güvenli Marker V2: adaptif duyarlılık ve ROI

Bu sürüm güvenli kalem noktası, etiket ve benzeri kâğıt değişiklikleri için
aşağıdaki ek iyileştirmeleri içerir:

- Referans görüntüsünün koyu ve açık bölgeleri ayrı duyarlılıkla değerlendirilir.
- Koyu bölgede düşük kontrastlı değişiklikler için daha düşük dinamik eşik kullanılır.
- Açık bölgede gölge ve kamera sıkıştırma parazitleri için daha sert eşik uygulanır.
- Yerel ortalama temelli adaptif eşik, global Otsu eşiğiyle birleştirilir.
- Arama yalnızca kalibre edilen eş merkezli daire alanının içinde yapılır.
- Kâğıt kenarları ve hedef dışı alan ROI maskesiyle devre dışı bırakılır.
- Büyük/bitişik işaret bileşenleri esnek şekil filtresinden geçirilir.
- Distance Transform ile birden fazla tepe bulunursa ayrı adaylar gösterilir.
- Bitişik veya bölünmüş adaylar otomatik gönderilmez; manuel kontrol ister.

Aday etiketlerindeki:
- `K`: koyu referans bölgesi
- `A`: açık referans bölgesi
- `Bitişik` / `Bölünmüş`: büyük bileşen veya ayrıştırılmış aday

anlamına gelir.

Hiçbir gerçek kamera sisteminde yüzde yüz doğruluk garanti edilemez. Bu paket
düşük güvenli ve bitişik sonuçları otomatik göndermeyerek yanlış pozitifleri azaltır.


## Crash Fix 4

`Temiz hedefi kaydet` sırasında mobil tarayıcının donmasına yol açan ağır,
tek-parça piksel işlemi düzeltildi.

- Her pikselde `Array.sort()` çalıştıran eski medyan hesabı kaldırıldı.
- 3/5 kare için sabit karşılaştırmalı hızlı medyan kullanıldı.
- Perspektif ve medyan işlemleri küçük parçalara bölündü.
- Her parça arasında tarayıcıya görüntü çizme ve kullanıcı arayüzünü güncelleme
  fırsatı verildi.
- Ham kare geçmişi 10 yerine 6 kareyle sınırlandı.
- Temiz referans düğmesinin çift tıklamayla iki işlem başlatması engellendi.


## Reference Crash Fix V2

İlk düzeltme yetersiz kaldığı için referans kaydetme yolu tamamen hafifletildi:

- Referans kaydında 5 ayrı perspektif dönüşümü kaldırıldı.
- Referans yalnızca tek sabit kareden oluşturulur.
- İşleme matrisi 500×500 yerine 360×360 kullanılır.
- Kamera yakalama genişliği 960 yerine 720 piksele düşürüldü.
- Ham kare geçmişi en fazla 4 kare tutulur.
- OpenCV matrisi doğrudan gri tampon üzerinden oluşturulur.
- Global JavaScript ve Promise hataları ekranda görünür.
- Otomatik değişiklik kontrolünde 3 karelik medyan korunur.

Bu sürümde `Temiz hedefi kaydet` işleminin tarayıcıyı kapatması veya sayfayı
kilitlemesi beklenmez. Bir hata kalırsa ekranda artık gerçek hata mesajı görünür.


## Reference No-OpenCV Fix

Bu sürümde `Temiz hedefi kaydet` yolu OpenCV/WebAssembly'den tamamen ayrıldı.

- Referans, perspektifi düzeltilmiş `ImageData` üzerinden saf JavaScript gri tamponu
  olarak kaydedilir.
- `cv.Mat` yalnızca otomatik değişiklik algılama gerçekten başlatıldığında oluşturulur.
- Köşe seçimi ve referans kaydı sırasında OpenCV belleği kullanılmaz.
- Referans sıfırlama ve zoom değişiminde hem JavaScript tamponu hem OpenCV matrisi
  temizlenir.
- Otomatik veya manuel kabul edilen yeni güvenli işaretlerden sonra iki referans biçimi
  birlikte güncellenir.

Bu düzeltme özellikle `Temiz hedefi kaydet` düğmesine basıldığı anda tarayıcı
sekmesinin kapanması, yeniden yüklenmesi veya boş ekrana düşmesi sorununu hedefler.


## Stabil Worker sürümü

Bu sürümde güvenli kalem noktası / etiket değişikliği analizi ana tarayıcı
iş parçacığından çıkarılmıştır.

- OpenCV.js tamamen kaldırıldı.
- Tek bir 360×360 perspektif kare alınır.
- Analiz için görüntü 180×180'e küçültülür.
- ±2 piksel hizalama, çift yönlü fark, dinamik koyu/açık eşik, ROI,
  hafif morphology ve bağlı bileşen analizi ayrı Web Worker içinde çalışır.
- Ana arayüz, kamera önizlemesi ve butonlar analiz sırasında donmaz.
- Aynı anda yalnızca bir analiz çalışabilir.
- Güven %82 altında veya iki aday birbirine yakınsa otomatik gönderim yapılmaz.
- Büyük/bitişik değişiklikler otomatik kabul edilmez ve manuel kontrol ister.

Hiçbir kamera sistemi için hatasız algılama garantisi verilemez. Bu sürümün amacı
donmayı kaldırmak ve belirsiz sonuçları otomatik göndermeyerek yanlış pozitifleri
azaltmaktır.
