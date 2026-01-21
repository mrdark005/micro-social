
const express = require('express');
const app = express();
const path = require('path');
const session = require('express-session');
const db = require('./db');
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const port = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
    secret: 'cok-gizli-bir-anahtar',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
});
app.use(sessionMiddleware);

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.use((socket, next) => {
    const session = socket.request.session;
    if (!session) {
        return next(new Error('Session not found'));
    }
    next();
});

const { generatePostId, getChatRoomId, requireLogin, bildirimEkle } = require('./utils/helpers')(io, db);

require('./socket/socketHandler')(io);

const authRoutes = require('./routes/auth');
app.use('/', authRoutes);

app.use(async (req, res, next) => {
    const kullaniciAdi = req.session.kullaniciAdi;

    res.locals.mevcutKullaniciAdi = kullaniciAdi;

    if (kullaniciAdi) {
        const kullanici = await db.get(kullaniciAdi);
        const bildirimler = (kullanici && kullanici.bildirimler) || [];
        const istekler = (kullanici && kullanici.arkadasIstekleri) || [];

        res.locals.okunmamisBildirimSayisi = bildirimler.filter(b => !b.okundu).length;
        res.locals.sonBildirimler = bildirimler.slice(0, 5);
        res.locals.toplamBildirimSayisi = bildirimler.length;

        res.locals.arkadasIstekleri = istekler;
        res.locals.istekSayisi = istekler.length;
    } else {
        res.locals.okunmamisBildirimSayisi = 0;
        res.locals.sonBildirimler = [];
        res.locals.toplamBildirimSayisi = 0;
        res.locals.arkadasIstekleri = [];
        res.locals.istekSayisi = 0;
    }
    next();
});


app.get("/bildirim/oku", requireLogin, async (req, res) => {
    const kullanici = await db.get(req.session.kullaniciAdi);
    if (kullanici && kullanici.bildirimler) {
        kullanici.bildirimler = kullanici.bildirimler.map(b => ({ ...b, okundu: true }));
        await db.set(req.session.kullaniciAdi, kullanici)
    }
    res.redirect('/panel');
})

app.get('/panel', requireLogin, async (req, res) => {
    const { arama, etiket } = req.query;

    let tumGonderiler = await db.get('posts') || [];

    if (arama && arama.trim() !== '') {
        const aramaKriteri = arama.trim().toLowerCase();
        tumGonderiler = tumGonderiler.filter(gonderi =>
            gonderi.icerik.toLowerCase().includes(aramaKriteri) ||
            gonderi.yazar.toLowerCase().includes(aramaKriteri)
        );
    }

    if (etiket && etiket.trim() !== '') {
        const etiketler = etiket.trim().split(/[\s,]+/).map(t => `#${t.toLowerCase().replace(/^#/, '')}`).filter(t => t !== '#');

        if (etiketler.length > 0) {
            tumGonderiler = tumGonderiler.filter(gonderi => {
                const icerikKucuk = gonderi.icerik.toLowerCase();
                return etiketler.some(etiketKriteri => icerikKucuk.includes(etiketKriteri));
            });
        }
    }

    res.render('panel', {
        kullaniciAdi: req.session.kullaniciAdi,
        siraliGonderiler: tumGonderiler.reverse(),
        arama: arama || '',
        etiket: etiket || ''
    });
});

app.get('/gonderi/yeni', requireLogin, (req, res) => {
    res.render('yeni_gonderi');
});

app.post('/gonderi/yeni', requireLogin, async (req, res) => {
    const { icerik, resimUrl } = req.body;
    const kullaniciAdi = req.session.kullaniciAdi;

    if (!icerik || icerik.trim() === '') { return res.redirect('/gonderi/yeni'); }

    const tumGonderiler = await db.get('posts') || [];
    const yeniGonderi = {
        id: generatePostId(tumGonderiler.length),
        yazar: kullaniciAdi,
        icerik: icerik,
        resimUrl: resimUrl && resimUrl.trim() !== '' ? resimUrl.trim() : null,
        zaman: new Date().toLocaleString('tr-TR'),
        begeniler: [],
        yorumlar: []
    };

    tumGonderiler.push(yeniGonderi);
    await db.set('posts', tumGonderiler);
    res.redirect('/panel');
});

app.get('/gonderi/like/:id', requireLogin, async (req, res) => {
    const { id: gonderiId } = req.params;
    const kullaniciAdi = req.session.kullaniciAdi;

    const tumGonderiler = await db.get('posts') || [];
    const gonderiIndex = tumGonderiler.findIndex(p => p.id === gonderiId);

    if (gonderiIndex === -1) { return res.redirect('/panel'); }

    const gonderi = tumGonderiler[gonderiIndex];

    const begeniler = gonderi.begeniler || [];
    const begenildi = begeniler.includes(kullaniciAdi);

    if (begenildi) {
        tumGonderiler[gonderiIndex].begeniler = begeniler.filter(u => u !== kullaniciAdi);
    } else {
        gonderi.begeniler = begeniler;
        gonderi.begeniler.push(kullaniciAdi);

        if (gonderi.yazar !== kullaniciAdi) {
            await bildirimEkle(
                gonderi.yazar,
                `${kullaniciAdi}, gönderinizi beğendi!`,
                '/panel'
            );
        }
    }

    await db.set('posts', tumGonderiler);
    res.redirect('/panel');
});

app.post('/gonderi/yorum/:id', requireLogin, async (req, res) => {
    const { id: gonderiId } = req.params;
    const { yorumIcerik } = req.body;
    const kullaniciAdi = req.session.kullaniciAdi;

    if (!yorumIcerik || yorumIcerik.trim() === '') { return res.redirect('/panel'); }

    const tumGonderiler = await db.get('posts') || [];
    const gonderiIndex = tumGonderiler.findIndex(p => p.id === gonderiId);

    if (gonderiIndex !== -1) {
        const gonderi = tumGonderiler[gonderiIndex];

        gonderi.yorumlar = gonderi.yorumlar || [];

        gonderi.yorumlar.push({
            yazar: kullaniciAdi,
            icerik: yorumIcerik,
            zaman: new Date().toLocaleString('tr-TR')
        });

        if (gonderi.yazar !== kullaniciAdi) {
            await bildirimEkle(
                gonderi.yazar,
                `${kullaniciAdi}, gönderinize yorum yaptı: "${yorumIcerik.substring(0, 20)}..."`,
                '/panel'
            );
        }
        await db.set('posts', tumGonderiler);
    }
    res.redirect('/panel');
});



app.post('/grup/olustur', requireLogin, async (req, res) => {
    const { grupAdi, uyeler } = req.body;
    const kurucu = req.session.kullaniciAdi;

    if (!grupAdi || !uyeler || !Array.isArray(uyeler) || uyeler.length === 0) {
        return res.redirect('/sohbet?hata=Gecersiz_grup_bilgileri');
    }

    const yeniGrupId = `grup_${Date.now()}`;
    const grupUyeleri = [...new Set([kurucu, ...uyeler])];

    const tumGruplar = await db.get('gruplar') || [];
    const yeniGrup = {
        id: yeniGrupId,
        ad: grupAdi,
        kurucu: kurucu,
        uyeler: grupUyeleri,
        olusturmaTarihi: new Date().toLocaleString('tr-TR'),
        img: 'https://i.ibb.co/2qcWw9w/group-default.png'
    };

    tumGruplar.push(yeniGrup);
    await db.set('gruplar', tumGruplar);

    const tumMesajlar = await db.get('mesajlar') || {};
    tumMesajlar[yeniGrupId] = [{
        gonderen: 'Sistem',
        icerik: `"${grupAdi}" grubu oluşturuldu.`,
        zaman: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        sistem: true
    }];
    await db.set('mesajlar', tumMesajlar);

    res.redirect(`/sohbet/${yeniGrupId}`);
});

app.get('/sohbet', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const mevcutKullanici = await db.get(mevcutKullaniciAdi);

    if (!mevcutKullanici) { return res.redirect('/cikis'); }

    const arkadasListesi = mevcutKullanici.arkadaslar || [];
    const arkadasDetaylariPromises = arkadasListesi.map(async (arkadasAdi) => {
        const detay = await db.get(arkadasAdi);
        return detay ? { ...detay, kullaniciAdi: arkadasAdi } : { kullaniciAdi: arkadasAdi, profilFotografi: 'https://i.ibb.co/L9L1s1K/default-profile.png' };
    });
    const arkadaslar = await Promise.all(arkadasDetaylariPromises);

    const tumMesajlar = await db.get('mesajlar') || {};
    const tumGruplar = await db.get('gruplar') || [];

    let aktifSohbetler = [];

    for (const roomId of Object.keys(tumMesajlar)) {
        if (roomId.startsWith('grup_')) continue;

        if (roomId.includes(mevcutKullaniciAdi)) {
            const parts = roomId.split('_');
            if (parts.includes(mevcutKullaniciAdi)) {
                const digerKullaniciAdi = parts.find(u => u !== mevcutKullaniciAdi) || mevcutKullaniciAdi;
                const digerKullanici = await db.get(digerKullaniciAdi);
                const mesajlar = tumMesajlar[roomId];
                const sonMesaj = mesajlar[mesajlar.length - 1];

                aktifSohbetler.push({
                    id: digerKullaniciAdi,
                    ad: digerKullaniciAdi,
                    profil: digerKullanici ? (digerKullanici.profilFotografi || 'https://i.ibb.co/L9L1s1K/default-profile.png') : 'https://i.ibb.co/L9L1s1K/default-profile.png',
                    status: digerKullanici ? digerKullanici.status : 'offline',
                    sonMesaj: sonMesaj,
                    tur: 'dm'
                });
            }
        }
    }

    const kullaniciGruplari = tumGruplar.filter(g => g.uyeler.includes(mevcutKullaniciAdi));
    for (const grup of kullaniciGruplari) {
        const mesajlar = tumMesajlar[grup.id] || [];
        const sonMesaj = mesajlar.length > 0 ? mesajlar[mesajlar.length - 1] : { icerik: 'Henüz mesaj yok', zaman: '' };

        aktifSohbetler.push({
            id: grup.id,
            ad: grup.ad,
            profil: grup.img,
            sonMesaj: sonMesaj,
            tur: 'grup'
        });
    }


    res.render('sohbetler', {
        mevcutKullaniciAdi,
        arkadaslar,
        aktifSohbetler
    });
});

app.get('/sohbet/:id', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const id = req.params.id;

    if (id.startsWith('grup_')) {
        const tumGruplar = await db.get('gruplar') || [];
        const grup = tumGruplar.find(g => g.id === id);

        if (!grup) {
            return res.status(404).render('hata', { mesaj: `Grup bulunamadı.` });
        }

        if (!grup.uyeler.includes(mevcutKullaniciAdi)) {
            return res.status(403).render('hata', { mesaj: `Bu gruba erişim izniniz yok.` });
        }

        const tumMesajlar = await db.get('mesajlar') || {};
        const mesajlar = tumMesajlar[id] || [];
        const roomId = id;

        const grupProfil = grup.img || 'https://i.ibb.co/2qcWw9w/group-default.png';
        const mevcutKullanici = await db.get(mevcutKullaniciAdi);
        const mevcutProfil = mevcutKullanici.profilFotografi || 'https://i.ibb.co/L9L1s1K/default-profile.png';

        return res.render('chat', {
            mevcutKullaniciAdi,
            hedefKullaniciAdi: grup.ad,
            hedefProfil: grupProfil,
            mevcutProfil,
            mesajlar,
            roomId,
            isGroup: true,
            grupId: id,
            grupUyeleri: grup.uyeler
        });
    }

    const hedefKullaniciAdi = id;

    if (mevcutKullaniciAdi === hedefKullaniciAdi) {
        return res.redirect('/sohbet');
    }

    const hedefKullanici = await db.get(hedefKullaniciAdi);
    if (!hedefKullanici) {
        return res.status(404).render('hata', { mesaj: `Kullanıcı bulunamadı: @${hedefKullaniciAdi}` });
    }

    const mevcutKullanici = await db.get(mevcutKullaniciAdi);
    const arkadasMi = (mevcutKullanici.arkadaslar || []).includes(hedefKullaniciAdi);

    if (!arkadasMi) {
        return res.render('hata', { mesaj: `Sohbet başlatmak için @${hedefKullaniciAdi} ile arkadaş olmalısınız.` });
    }

    const roomId = getChatRoomId(mevcutKullaniciAdi, hedefKullaniciAdi);
    const tumMesajlar = await db.get('mesajlar') || {};
    const mesajlar = tumMesajlar[roomId] || [];

    const hedefProfil = hedefKullanici.profilFotografi || 'https://i.ibb.co/L9L1s1K/default-profile.png';
    const mevcutProfil = mevcutKullanici.profilFotografi || 'https://i.ibb.co/L9L1s1K/default-profile.png';

    res.render('chat', {
        mevcutKullaniciAdi,
        hedefKullaniciAdi,
        hedefProfil,
        mevcutProfil,
        mesajlar,
        roomId,
        isGroup: false,
        hedefStatus: hedefKullanici.status || 'offline'
    });
});


app.get('/profil', requireLogin, async (req, res) => {
    const hedefKullaniciAdi = req.session.kullaniciAdi;
    const mevcutKullaniciAdi = req.session.kullaniciAdi;

    const hedefKullanici = await db.get(hedefKullaniciAdi);
    if (hedefKullanici) { hedefKullanici.kullaniciAdi = hedefKullaniciAdi; }

    if (!hedefKullanici) { return res.redirect('/cikis'); }

    const kullaniciGonderileri = (await db.get('posts') || [])
        .filter(p => p.yazar === hedefKullaniciAdi)
        .reverse();

    res.render('profil', {
        hedefKullanici: hedefKullanici,
        kullaniciGonderileri: kullaniciGonderileri,
        arkadasMi: false,
        istekGonderilmisMi: false,
        kendiProfilimi: true,
        mevcutKullaniciAdi: mevcutKullaniciAdi
    });
});

app.get('/profil/:kullaniciAdi', requireLogin, async (req, res) => {
    const hedefKullaniciAdi = req.params.kullaniciAdi;
    const mevcutKullaniciAdi = req.session.kullaniciAdi;

    if (hedefKullaniciAdi === mevcutKullaniciAdi) { return res.redirect('/profil'); }

    const [hedefKullanici, mevcutKullanici] = await Promise.all([
        db.get(hedefKullaniciAdi),
        db.get(mevcutKullaniciAdi)
    ]);

    if (!hedefKullanici) {
        return res.status(404).render('hata', { mesaj: `Kullanici bulunamadi: @${hedefKullaniciAdi}` });
    }

    hedefKullanici.kullaniciAdi = hedefKullaniciAdi;

    const kullaniciGonderileri = (await db.get('posts') || [])
        .filter(p => p.yazar === hedefKullaniciAdi)
        .reverse();

    const mevcutKullaniciArkadaslari = mevcutKullanici ? (mevcutKullanici.arkadaslar || []) : [];
    const arkadasMi = mevcutKullaniciArkadaslari.includes(hedefKullaniciAdi);

    const istekGonderilmisMi = (hedefKullanici.arkadasIstekleri || []).includes(mevcutKullaniciAdi);

    res.render('profil', {
        hedefKullanici: hedefKullanici,
        kullaniciGonderileri: kullaniciGonderileri,
        arkadasMi: arkadasMi,
        istekGonderilmisMi: istekGonderilmisMi,
        kendiProfilimi: false,
        mevcutKullaniciAdi: mevcutKullaniciAdi
    });
});

app.get('/profil_duzenle', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;
    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici) {
        return res.redirect('/cikis');
    }

    kullanici.kullaniciAdi = kullaniciAdi;

    res.render('profil_duzenle', {
        kullanici: kullanici
    });
});

app.post('/profil_duzenle', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;
    const { profilFotografi, arkaPlanFotografi } = req.body;

    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici) {
        return res.redirect('/cikis');
    }

    if (profilFotografi && profilFotografi.trim() !== '') {
        kullanici.profilFotografi = profilFotografi.trim();
    }

    if (arkaPlanFotografi && arkaPlanFotografi.trim() !== '') {
        kullanici.arkaPlanFotografi = arkaPlanFotografi.trim();
    }

    await db.set(kullaniciAdi, kullanici);

    res.redirect('/profil');
});

app.get('/arkadas_ekle/:hedefKullaniciAdi', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const hedefKullaniciAdi = req.params.hedefKullaniciAdi;

    if (mevcutKullaniciAdi === hedefKullaniciAdi) { return res.redirect(`/profil`); }

    const hedefKullanici = await db.get(hedefKullaniciAdi);

    if (!hedefKullanici) {
        return res.status(404).render('hata', { mesaj: `Arkadas olarak eklemek istediginiz kullanici bulunamadi: @${hedefKullaniciAdi}` });
    }

    hedefKullanici.arkadasIstekleri = hedefKullanici.arkadasIstekleri || [];

    if (!hedefKullanici.arkadasIstekleri.includes(mevcutKullaniciAdi)) {
        hedefKullanici.arkadasIstekleri.push(mevcutKullaniciAdi);
        await db.set(hedefKullaniciAdi, hedefKullanici);

        await bildirimEkle(
            hedefKullaniciAdi,
            `${mevcutKullaniciAdi} size arkadaslik istegi gönderdi.`,
            `/arkadaslarim`
        );
    }

    res.redirect(`/profil/${hedefKullaniciAdi}`);
});

app.get('/istek_yonet/kabul/:gonderenKullaniciAdi', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const gonderenKullaniciAdi = req.params.gonderenKullaniciAdi;

    const [mevcutKullanici, gonderenKullanici] = await Promise.all([
        db.get(mevcutKullaniciAdi),
        db.get(gonderenKullaniciAdi)
    ]);

    if (!mevcutKullanici || !gonderenKullanici) {
        return res.redirect('/panel');
    }

    mevcutKullanici.arkadasIstekleri = (mevcutKullanici.arkadasIstekleri || [])
        .filter(u => u !== gonderenKullaniciAdi);

    mevcutKullanici.arkadaslar = mevcutKullanici.arkadaslar || [];
    gonderenKullanici.arkadaslar = gonderenKullanici.arkadaslar || [];

    if (!mevcutKullanici.arkadaslar.includes(gonderenKullaniciAdi)) {
        mevcutKullanici.arkadaslar.push(gonderenKullaniciAdi);
    }
    if (!gonderenKullanici.arkadaslar.includes(mevcutKullaniciAdi)) {
        gonderenKullanici.arkadaslar.push(mevcutKullaniciAdi);
    }

    await Promise.all([
        db.set(mevcutKullaniciAdi, mevcutKullanici),
        db.set(gonderenKullaniciAdi, gonderenKullanici)
    ]);

    await bildirimEkle(
        gonderenKullaniciAdi,
        `${mevcutKullaniciAdi} arkadaslik isteginizi kabul etti! 🎉`,
        `/profil/${mevcutKullaniciAdi}`
    );

    res.redirect('/arkadaslarim');
});

app.get('/istek_yonet/reddet/:gonderenKullaniciAdi', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const gonderenKullaniciAdi = req.params.gonderenKullaniciAdi;

    const mevcutKullanici = await db.get(mevcutKullaniciAdi);

    if (mevcutKullanici) {
        mevcutKullanici.arkadasIstekleri = (mevcutKullanici.arkadasIstekleri || [])
            .filter(u => u !== gonderenKullaniciAdi);

        await db.set(mevcutKullaniciAdi, mevcutKullanici);

    }

    res.redirect('/arkadaslarim');
});


app.get('/arkadas_cikar/:hedefKullaniciAdi', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const hedefKullaniciAdi = req.params.hedefKullaniciAdi;

    const [mevcutKullanici, hedefKullanici] = await Promise.all([
        db.get(mevcutKullaniciAdi),
        db.get(hedefKullaniciAdi)
    ]);

    if (mevcutKullanici && hedefKullanici) {
        mevcutKullanici.arkadaslar = mevcutKullanici.arkadaslar || [];
        hedefKullanici.arkadaslar = hedefKullanici.arkadaslar || [];

        mevcutKullanici.arkadaslar = mevcutKullanici.arkadaslar.filter(a => a !== hedefKullaniciAdi);
        hedefKullanici.arkadaslar = hedefKullanici.arkadaslar.filter(a => a !== mevcutKullaniciAdi);

        await Promise.all([
            db.set(mevcutKullaniciAdi, mevcutKullanici),
            db.set(hedefKullaniciAdi, hedefKullanici)
        ]);
    }

    res.redirect(`/profil/${hedefKullaniciAdi}`);
});

app.get('/arkadaslarim', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const mevcutKullanici = await db.get(mevcutKullaniciAdi);

    if (!mevcutKullanici) { return res.redirect('/cikis'); }

    const arkadasListesi = mevcutKullanici.arkadaslar || [];
    const arkadasDetaylariPromises = arkadasListesi.map(async (arkadasAdi) => {
        const detay = await db.get(arkadasAdi);
        return detay ? { ...detay, kullaniciAdi: arkadasAdi } : { kullaniciAdi: arkadasAdi, profilFotografi: 'https://i.ibb.co/L9L1s1K/default-profile.png' };
    });
    const arkadaslar = await Promise.all(arkadasDetaylariPromises);

    const istekListesi = mevcutKullanici.arkadasIstekleri || [];
    const istekDetaylariPromises = istekListesi.map(async (istekAdi) => {
        const detay = await db.get(istekAdi);
        return detay ? { ...detay, kullaniciAdi: istekAdi } : { kullaniciAdi: istekAdi, profilFotografi: 'https://i.ibb.co/L9L1s1K/default-profile.png' };
    });
    const istekler = await Promise.all(istekDetaylariPromises);


    res.render('arkadaslarim', {
        kullaniciAdi: mevcutKullaniciAdi,
        arkadaslar: arkadaslar,
        gelenIstekler: istekler
    });
});


app.get('/ayarlar', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;
    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici) {
        return res.redirect('/cikis');
    }

    kullanici.kullaniciAdi = kullaniciAdi;

    res.render('ayarlar', {
        kullanici: kullanici
    });
});

app.post('/ayarlar/profil', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;
    const { profilFotografi, arkaPlanFotografi } = req.body;

    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici) {
        return res.redirect('/cikis');
    }

    if (profilFotografi && profilFotografi.trim() !== '') {
        kullanici.profilFotografi = profilFotografi.trim();
    }

    if (arkaPlanFotografi && arkaPlanFotografi.trim() !== '') {
        kullanici.arkaPlanFotografi = arkaPlanFotografi.trim();
    }

    await db.set(kullaniciAdi, kullanici);

    res.redirect('/ayarlar');
});

app.post('/ayarlar/sifre', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;
    const { mevcutSifre, yeniSifre, yeniSifreTekrar } = req.body;

    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici) {
        return res.redirect('/cikis');
    }

    if (kullanici.sifre !== mevcutSifre) {
        return res.redirect('/ayarlar?hata=Mevcut_sifre_yanlis');
    }

    if (yeniSifre !== yeniSifreTekrar) {
        return res.redirect('/ayarlar?hata=Yeni_sifreler_eslesmiyor');
    }

    if (yeniSifre.length < 4) {
        return res.redirect('/ayarlar?hata=Sifre_en_az_4_karakter_olmali');
    }

    kullanici.sifre = yeniSifre;
    await db.set(kullaniciAdi, kullanici);

    res.redirect('/ayarlar?basari=Sifre_basariyla_degistirildi');
});

app.post('/ayarlar/hesap-sil', requireLogin, async (req, res) => {
    const kullaniciAdi = req.session.kullaniciAdi;

    await db.delete(kullaniciAdi);

    const tumGonderiler = await db.get('posts') || [];
    const filtrelenmisGonderiler = tumGonderiler.filter(p => p.yazar !== kullaniciAdi);
    await db.set('posts', filtrelenmisGonderiler);

    const tumKullanicilar = await db.all();
    for (const [key, value] of Object.entries(tumKullanicilar)) {
        if (key !== 'posts' && key !== 'mesajlar' && value.arkadaslar) {
            value.arkadaslar = value.arkadaslar.filter(a => a !== kullaniciAdi);
            value.arkadasIstekleri = (value.arkadasIstekleri || []).filter(a => a !== kullaniciAdi);
            await db.set(key, value);
        }
    }

    req.session.destroy(err => {
        if (err) return res.status(500).send('Hesap silindi ancak oturum sonlandirilamadi.');
        res.redirect('/giris?basari=Hesabiniz_basariyla_silindi');
    });
});

server.listen(port, () => {
    console.log(`Sunucu http://localhost:${port} adresinde calisiyor.`);
});
