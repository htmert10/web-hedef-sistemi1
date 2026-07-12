# Hedef Takip Sistemi

Telefon kamerasıyla 10 m havalı tabanca kâğıt hedefindeki yeni fiziksel değişimi
bulur ve koordinatı WebSocket üzerinden dijital maç ekranına gönderir.

## Temel akış

1. Telefonda `/tablet`, bilgisayarda `/dashboard` açılır.
2. Telefon kamerası başlatılır.
3. Kâğıdın dört dış köşesi sol üstten başlayarak saat yönünde seçilir.
4. Hedef temizken referans kaydedilir.
5. Algılama başlatılır.

Algılama tek bir renge bağlı değildir. Üç kare medyanı, küçük kamera kayması
hizalaması, genel parlaklık düzeltmesi, referans kenarı bastırma, minimum fiziksel
boyut, alan, en-boy oranı ve doluluk ölçülerini birlikte kullanır.

## Maç seçenekleri

- Serbest antrenman
- 40 atış / 50 dakika antrenman
- 50 atış / 50 dakika özel maç
- ISSF 10 m 60 atış / 75 dakika

## Çalıştırma

```powershell
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Telefon kamerası için yayın ortamında HTTPS gereklidir.

## Sınırlar

Bu sistem resmî elektronik hedef değildir. Telefon mutlaka sabitlenmeli, kâğıdın
dört köşesi doğru seçilmeli ve ışık hedef üzerinde atış sırasında değişmemelidir.
