
const express = require('express');
const app = express();
const path = require('path');
const session = require('express-session');

const DarkDB = require("darkdb")
const db = new DarkDB({
    name: "darkdb",
    separator: ".",
    jsonSpaces: 4,
    format:"json",
    autoFile:false
});

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


function getChatRoomId(user1, user2) {
    const sortedUsers = [user1, user2].sort();
    return sortedUsers.join('_');
}

async function bildirimEkle(aliciKullaniciAdi, mesaj, link) {
    const alici = await db.get(aliciKullaniciAdi);
    if (!alici) return;

    alici.bildirimler = alici.bildirimler || [];

    const yeniBildirim = {
        mesaj: mesaj,
        link: link || '/panel',
        okundu: false,
        zaman: new Date().toLocaleString('tr-TR')
    };

    alici.bildirimler.unshift(yeniBildirim);
    await db.set(aliciKullaniciAdi, alici);

    io.to(aliciKullaniciAdi).emit('yeniBildirim', {
        mesaj: yeniBildirim.mesaj,
        okunmamisSayisi: alici.bildirimler.filter(b => !b.okundu).length
    });
}

const generatePostId = (index) => `post_${Date.now()}_${index}`;


const requireLogin = (req, res, next) => {
    if (req.session.kullaniciAdi) {
        return next();
    }
    res.redirect('/giris?hata=Giris_yapmaniz_gerekmektedir.');
};

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




app.get('/', (req, res) => { res.redirect('/giris'); });

app.get('/kayit', (req, res) => { res.render('kayit', { hata: null }); });

app.post('/kayit', async (req, res) => {
    const { kullaniciAdi, sifre } = req.body;
    if (await db.get(kullaniciAdi)) {
        return res.render('kayit', { hata: 'Bu kullanici adi zaten alinmis.' });
    }

    await db.set(kullaniciAdi, {
        kullaniciAdi: kullaniciAdi,
        sifre: sifre,
        olusturmaTarihi: new Date(),
        bildirimler: [],
        arkadaslar: [],
        arkadasIstekleri: [],
        profilFotografi: "cdn/defultUserProfil.png",
        arkaPlanFotografi: ' '
    });
    res.redirect('/giris');
});

app.get('/giris', (req, res) => {
    const urlHata = req.query.hata ? decodeURIComponent(req.query.hata) : null;
    res.render('giris', { hata: urlHata, basari: null });
});

app.post('/giris', async (req, res) => {
    const { kullaniciAdi, sifre } = req.body;
    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici || kullanici.sifre !== sifre) {
        return res.render('giris', { hata: 'Kullanici adi veya sifre yanlis.', basari: null });
    }

    req.session.kullaniciAdi = kullaniciAdi;
    req.session.girisZamani = new Date().toLocaleString();
    res.redirect('/panel');
});

app.get('/cikis', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).send('Oturum sonlandirilamadi.');
        res.redirect('/giris');
    });
});

app.get("/bildirim/oku", requireLogin, async (req, res) => {
    const kullanici = await db.get(req.session.kullaniciAdi);
    kullanici.bildirimler = kullanici.bildirimler.map(b => ({ ...b, okundu: true }));
    await db.set(req.session.kullaniciAdi, kullanici)
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
                `${kullaniciAdi}, g�nderinizi begendi!`,
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
                `${kullaniciAdi}, g�nderinize yorum yapti: "${yorumIcerik.substring(0, 20)}..."`,
                '/panel'
            );
        }
        await db.set('posts', tumGonderiler);
    }
    res.redirect('/panel');
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
    const sohbetEdilebilirKullanicilar = await Promise.all(arkadasDetaylariPromises);


    res.render('sohbetler', {
        mevcutKullaniciAdi,
        arkadaslar: sohbetEdilebilirKullanicilar
    });
});

app.get('/sohbet/:hedefKullaniciAdi', requireLogin, async (req, res) => {
    const mevcutKullaniciAdi = req.session.kullaniciAdi;
    const hedefKullaniciAdi = req.params.hedefKullaniciAdi;

    if (mevcutKullaniciAdi === hedefKullaniciAdi) {
        return res.redirect('/sohbet');
    }

    const hedefKullanici = await db.get(hedefKullaniciAdi);
    if (!hedefKullanici) {
        return res.status(404).render('hata', { mesaj: `Kullanici bulunamadi: @${hedefKullaniciAdi}` });
    }

    const mevcutKullanici = await db.get(mevcutKullaniciAdi);
    const arkadasMi = (mevcutKullanici.arkadaslar || []).includes(hedefKullaniciAdi);

    if (!arkadasMi) {
        return res.render('hata', { mesaj: `Sohbet baslatmak i�in @${hedefKullaniciAdi} ile arkadas olmalisiniz.` });
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
        roomId
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
            `${mevcutKullaniciAdi} size arkadaslik istegi g�nderdi.`,
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
        `${mevcutKullaniciAdi} arkadaslik isteginizi kabul etti! ??`,
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


/*
var currentToken = "ultrasecrettoken"

app.get("/api", requireLogin, (req, res) => {
    const token = req.query.token;
    const key = req.query.key
    if (token !== currentToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (key) {
        const database = db.get(key);
        res.json(database);
    } else {
        const database = db.all();
        res.json(database);
    }
})
*/

io.on('connection', (socket) => {
    const kullaniciAdi = socket.request.session?.kullaniciAdi;

    if (!kullaniciAdi) {
        console.log('[Socket] Oturumsuz baglanti reddedildi');
        socket.disconnect();
        return;
    }

    socket.join(kullaniciAdi);
    console.log(`[Socket] ${kullaniciAdi} baglandi (ID: ${socket.id})`);

    socket.on('join_chat_room', (roomId) => {
        socket.join(roomId);
        console.log(`[Socket] ${kullaniciAdi} sohbet odasina katildi: ${roomId}`);
    });

    socket.on('send_message', async (data) => {
        try {
            const { roomId, hedefKullaniciAdi, mesajIcerigi } = data;

            if (!mesajIcerigi || mesajIcerigi.trim() === '') {
                return;
            }

            const yeniMesaj = {
                gonderen: kullaniciAdi,
                icerik: mesajIcerigi.trim(),
                zaman: new Date().toLocaleTimeString('tr-TR', {
                    hour: '2-digit',
                    minute: '2-digit'
                })
            };

            const tumMesajlar = await db.get('mesajlar') || {};
            tumMesajlar[roomId] = tumMesajlar[roomId] || [];
            tumMesajlar[roomId].push(yeniMesaj);
            await db.set('mesajlar', tumMesajlar);

            socket.broadcast.to(roomId).emit('receive_message', yeniMesaj);

            await bildirimEkle(
                hedefKullaniciAdi,
                `${kullaniciAdi} size mesaj g�nderdi: "${mesajIcerigi.substring(0, 30)}..."`,
                `/sohbet/${kullaniciAdi}`
            );

            console.log(`[Socket] Mesaj: ${kullaniciAdi} -> ${hedefKullaniciAdi}`);

        } catch (error) {
            console.error('[Socket] Mesaj hatasi:', error);
            socket.emit('message_error', { message: 'Mesaj g�nderilemedi' });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[Socket] ${kullaniciAdi} ayrildi (${reason})`);
    });

    socket.on('error', (error) => {
        console.error(`[Socket] ${kullaniciAdi} hata:`, error);
    });
});

server.listen(port, () => {
    console.log(`Sunucu http://localhost:${port} adresinde �alisiyor.`);
});
