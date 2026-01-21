
const generatePostId = (index) => `post_${Date.now()}_${index}`;

function getChatRoomId(user1, user2) {
    const sortedUsers = [user1, user2].sort();
    return sortedUsers.join('_');
}

const requireLogin = (req, res, next) => {
    if (req.session.kullaniciAdi) {
        return next();
    }
    res.redirect('/giris?hata=Giris_yapmaniz_gerekmektedir.');
};

module.exports = (io, db) => {
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

        if (io) {
            io.to(aliciKullaniciAdi).emit('yeniBildirim', {
                mesaj: yeniBildirim.mesaj,
                okunmamisSayisi: alici.bildirimler.filter(b => !b.okundu).length
            });
        }
    }

    return {
        generatePostId,
        getChatRoomId,
        requireLogin,
        bildirimEkle
    };
};
