const db = require('../db');

module.exports = (io) => {
    const { bildirimEkle } = require('../utils/helpers')(io, db);

    io.on('connection', async (socket) => {
        const kullaniciAdi = socket.request.session?.kullaniciAdi;

        if (!kullaniciAdi) {
            console.log('[Socket] Oturumsuz baglanti reddedildi');
            socket.disconnect();
            return;
        }

        const kullanici = await db.get(kullaniciAdi);
        if (kullanici) {
            kullanici.status = 'online';
            await db.set(kullaniciAdi, kullanici);
        }

        io.emit('status_update', { kullaniciAdi, status: 'online' });

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

                if (roomId.startsWith('grup_')) {
                    const tumGruplar = await db.get('gruplar') || [];
                    const grup = tumGruplar.find(g => g.id === roomId);
                    if (grup) {
                        for (const uye of grup.uyeler) {
                            if (uye !== kullaniciAdi) {
                                await bildirimEkle(
                                    uye,
                                    `"${grup.ad}" grubunda ${kullaniciAdi}: "${mesajIcerigi.substring(0, 20)}..."`,
                                    `/sohbet/${roomId}`
                                );
                            }
                        }
                    }
                } else {
                    await bildirimEkle(
                        hedefKullaniciAdi,
                        `${kullaniciAdi} size mesaj gönderdi: "${mesajIcerigi.substring(0, 30)}..."`,
                        `/sohbet/${kullaniciAdi}`
                    );
                }

                console.log(`[Socket] Mesaj (${roomId}): ${kullaniciAdi} -> ...`);

            } catch (error) {
                console.error('[Socket] Mesaj hatasi:', error);
                socket.emit('message_error', { message: 'Mesaj gonderilemedi' });
            }
        });

        socket.on('disconnect', async (reason) => {
            const kullanici = await db.get(kullaniciAdi);
            if (kullanici) {
                kullanici.status = 'offline';
                await db.set(kullaniciAdi, kullanici);
            }
            io.emit('status_update', { kullaniciAdi, status: 'offline' });

            console.log(`[Socket] ${kullaniciAdi} ayrildi (${reason})`);
        });

        socket.on('error', (error) => {
            console.error(`[Socket] ${kullaniciAdi} hata:`, error);
        });
    });
};
