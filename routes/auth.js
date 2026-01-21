const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
    res.redirect('/giris');
});

router.get('/kayit', (req, res) => {
    if(req.session.kullaniciAdi){
        res.redirect('/panel')
    }else{
        res.render('kayit', { hata: null });
    }
});

router.post('/kayit', async (req, res) => {
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
        profilFotografi: "https://i.ibb.co/L9L1s1K/default-profile.png",
        arkaPlanFotografi: ' '
    });
    res.redirect('/giris');
});

router.get('/giris', (req, res) => {
    if(req.session.kullaniciAdi) {
        res.redirect('/panel');
    }else{
    const urlHata = req.query.hata ? decodeURIComponent(req.query.hata) : null;
    const urlBasari = req.query.basari ? decodeURIComponent(req.query.basari) : null;
    res.render('giris', { hata: urlHata, basari: urlBasari });
}
});

router.post('/giris', async (req, res) => {
    const { kullaniciAdi, sifre } = req.body;
    const kullanici = await db.get(kullaniciAdi);

    if (!kullanici || kullanici.sifre !== sifre) {
        return res.render('giris', { hata: 'Kullanici adi veya sifre yanlis.', basari: null });
    }

    req.session.kullaniciAdi = kullaniciAdi;
    req.session.girisZamani = new Date().toLocaleString();
    res.redirect('/panel');
});

router.get('/cikis', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).send('Oturum sonlandirilamadi.');
        res.redirect('/giris');
    });
});

module.exports = router;
