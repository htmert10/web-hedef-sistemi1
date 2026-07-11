# Web Hedef Sistemi — MVP 0.1

Bu proje iki web ekranından oluşur:

- `/tablet`: telefon/tablet kamerası ve mikrofonu
- `/dashboard`: laptopta dijital hedef, puan, ortalama ve grupman

## Ne çalışıyor?

- Kamera ve mikrofon izni
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
