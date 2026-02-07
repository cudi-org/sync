window.Cudi.handleFileSelection = function (file) {
    const state = window.Cudi.state;
    state.archivoParaEnviar = file;

    // Basic check for size immediately
    const limitMB = parseInt(window.currentSettings?.maxFileSize || "0");
    if (limitMB > 0 && file.size > limitMB * 1024 * 1024) {
        window.Cudi.showToast(`File too large. Limit is ${limitMB}MB.`, "error");
        state.archivoParaEnviar = null;
        return;
    }

    if (state.dataChannel && state.dataChannel.readyState === "open") {
        window.Cudi.enviarArchivo();
    } else {
        state.enviarArchivoPendiente = true;
        window.Cudi.showToast(`Selected ${file.name}. Queued.`, "info");
    }
}

// Global monitoring variables
let lastBufferedAmount = 0;
let stallCount = 0;

// Helper for binary comparison
function compareBuffers(buf1, buf2) {
    if (buf1.byteLength != buf2.byteLength) return false;
    const dv1 = new Int8Array(buf1);
    const dv2 = new Int8Array(buf2);
    for (let i = 0; i != buf1.byteLength; i++) {
        if (dv1[i] != dv2[i]) return false;
    }
    return true;
}

window.Cudi.enviarArchivo = async function () {
    const state = window.Cudi.state;
    if (!state.archivoParaEnviar) return;
    if (!state.dataChannel) return;

    const file = state.archivoParaEnviar;
    const limitMB = parseInt(window.currentSettings?.maxFileSize || "0");
    if (limitMB > 0 && file.size > limitMB * 1024 * 1024) {
        window.Cudi.showToast(`File too large. Limit is ${limitMB}MB.`, "error");
        return;
    }

    if (file.size === 0) {
        window.Cudi.showToast("Cannot send empty files.", "error");
        return;
    }

    // 1. Send Meta (No global hash, we will verify per chunk)
    // Send "await_acceptance" hint so receiver knows we are waiting
    try {
        state.dataChannel.send(JSON.stringify({
            type: "meta",
            nombre: file.name,
            tamaño: file.size,
            tipoMime: file.type,
            hash: null, // No global hash needed
            hashType: 'chunk' // Signal to Receiver to verify every packet
        }));

        window.Cudi.displayChatMessage(`Request sent: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB). Waiting for acceptance...`, "sent", "You");
        window.Cudi.showToast("Waiting for peer to accept transfer...", "info");
        state.isWaitingForTransferStart = true;

    } catch (e) {
        console.error("Error sending meta:", e);
        return;
    }
}

window.Cudi.startFileStreaming = async function () {
    const state = window.Cudi.state;
    const file = state.archivoParaEnviar;
    if (!file) {
        console.warn("No file to stream?");
        return;
    }

    let offset = 0;
    let lastLoggedPercent = 0;
    const CHUNK_SIZE = 32 * 1024; // Bájalo a 32KB
    // Buffer threshold: 1MB as requested by user
    const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;
    state.dataChannel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;

    window.Cudi.showToast(`Header accepted! Sending: ${file.name}...`, "info");
    console.log("[CUDI] Iniciando transferencia optimizada...");

    let bytesEnUltimoSegundo = 0;
    const monitorVelocidad = setInterval(() => {
        if (!state.isWaitingForTransferStart || offset >= file.size) {
            clearInterval(monitorVelocidad);
            return;
        }
        const mbPorSegundo = (bytesEnUltimoSegundo / (1024 * 1024)).toFixed(2);
        console.log(`[CUDI] Velocidad actual: ${mbPorSegundo} MB/s | Progreso: ${((offset / file.size) * 100).toFixed(1)}%`);
        bytesEnUltimoSegundo = 0;
    }, 1000);

    try {
        let chunksProcesados = 0;
        while (offset < file.size) {
            // Check if user cancelled or connection died
            if (state.dataChannel.readyState !== 'open') throw new Error("Connection lost");

            // --- LOGS DE DIAGNÓSTICO DETALLADO ---
            if (chunksProcesados % 50 === 0) {
                const currentBufferedAmount = state.dataChannel.bufferedAmount;
                const drainageRate = lastBufferedAmount - currentBufferedAmount;
                lastBufferedAmount = currentBufferedAmount;

                if (currentBufferedAmount > 0 && drainageRate <= 0) {
                    stallCount++;
                    if (stallCount > 5) {
                        console.error("[CRÍTICO] La red no está drenando datos. Posible bloqueo de firewall o saturación de MTU.");
                    }
                } else {
                    stallCount = 0;
                    if (drainageRate > 0) {
                        console.log(`[RED] Tasa de drenaje: ${(drainageRate / 1024).toFixed(1)} KB/ciclo`);
                    }
                }

                const bufferActual = currentBufferedAmount;
                const ratioSaturacion = ((bufferActual / (1 * 1024 * 1024)) * 100).toFixed(1);

                console.log(`[DIAGNÓSTICO] Buffer: ${(bufferActual / 1024).toFixed(0)}KB (${ratioSaturacion}%) | Offset: ${(offset / 1024 / 1024).toFixed(1)}MB`);

                if (bufferActual === 0) {
                    console.warn("[ALERTA] El buffer está vacío. El código va más lento que la red (Tubería vacía).");
                } else if (ratioSaturacion > 80) {
                    console.info("[ALERTA] El buffer está lleno. La red va más lenta que el código (Cuello de botella en internet).");
                }
            }

            // CONTROL DE FLUJO AGRESIVO:
            // Solo frenamos si el buffer supera los 4MB.
            // Usamos un bucle de espera (polling) en lugar de eventos para mayor reactividad en alta velocidad.
            if (state.dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                // Esperar 10ms y re-evaluar (Loop 'continue' implícito al no avanzar offset)
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }

            // 2. Read Chunk
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const chunkBuffer = await slice.arrayBuffer();

            // 3. Compute Hash of this chunk (Required by Receiver protocol)
            const chunkHash = await crypto.subtle.digest('SHA-256', chunkBuffer); // 32 bytes

            // 4. Pack: [Hash (32B)] + [Data]
            const packet = new Uint8Array(32 + chunkBuffer.byteLength);
            packet.set(new Uint8Array(chunkHash), 0);
            packet.set(new Uint8Array(chunkBuffer), 32);

            // 5. Send
            state.dataChannel.send(packet);

            bytesEnUltimoSegundo += packet.byteLength;

            // Debug Log (Percentage based) - Less frequent
            const percent = Math.floor(((offset + CHUNK_SIZE) / file.size) * 100);
            if (percent > lastLoggedPercent && percent % 5 === 0) {
                lastLoggedPercent = percent;
            }

            offset += CHUNK_SIZE;
            chunksProcesados++;

            // Respiro de RAM mucho más espaciado (cada ~50MB procesados)
            if ((offset / CHUNK_SIZE) % 400 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        console.log(`[Sender] Finished. Total bytes sent: ${file.size}`);
        console.log("[CUDI] Envío finalizado con éxito.");
        window.Cudi.showToast("File sent successfully!", "success");
        state.archivoParaEnviar = null;
        state.isWaitingForTransferStart = false;
        if (document.getElementById("fileInput")) document.getElementById("fileInput").value = "";

    } catch (err) {
        clearInterval(monitorVelocidad);
        console.error("Error sending file:", err);
        window.Cudi.showToast("Error sending file.", "error");
        state.isWaitingForTransferStart = false;
    }
}

window.Cudi.processBuffer = async function (data) {
    const state = window.Cudi.state;

    // Check if we need to extract and verify hash
    let dataContent = data;

    if (state.hashType === 'chunk') {
        if (data.byteLength <= 32) {
            console.error("Received packet too small for chunk-hash verification");
            return; // Ignore invalid packet
        }

        // Extract Hash and Content
        const receivedHash = data.slice(0, 32);
        dataContent = data.slice(32);

        // Verify Integrity
        try {
            const calculatedHash = await crypto.subtle.digest('SHA-256', dataContent);
            if (!compareBuffers(receivedHash, calculatedHash)) {
                console.error("CHUNK INTEGRITY FAILED");
                window.Cudi.showToast("⚠️ Transmission Error: Chunk Corrupted. Aborting.", "error");
                state.tamañoArchivoEsperado = 0;

                // Abort writable if exists
                if (state.fileWritable) {
                    await state.fileWritable.abort();
                    state.fileWritable = null;
                    state.fileHandle = null;
                }
                return;
            }

        } catch (e) {
            console.error("Verification error:", e);
            return;
        }
    }

    // --- DIRECT TO DISK WRITING (FileSystem Access API) ---
    if (state.fileWritable) {
        try {
            await state.fileWritable.write(dataContent);
        } catch (e) {
            console.error("Disk Write Error:", e);
            window.Cudi.showToast("Disk write failed (Space full?)", "error");
            state.tamañoArchivoEsperado = 0; // Stop
            return;
        }
    } else {
        // Fallback: RAM (Only if no fileWritable set)
        state.archivoRecibidoBuffers.push(dataContent);
    }

    // Optimize counter
    if (typeof state.bytesReceived === 'undefined') state.bytesReceived = 0;
    state.bytesReceived += dataContent.byteLength;

    // Log Progress (Receiver)
    if (state.tamañoArchivoEsperado > 0) {
        const percent = Math.floor((state.bytesReceived / state.tamañoArchivoEsperado) * 100);
        if (typeof state.lastLoggedPercent === 'undefined') state.lastLoggedPercent = 0;

        if (percent > state.lastLoggedPercent && percent % 5 === 0) {
            console.log(`[Receiver] Progress: ${percent}% (${(state.bytesReceived / 1024 / 1024).toFixed(2)} MB)`);
            state.lastLoggedPercent = percent;
        }
    }

    // Check completion
    if (state.bytesReceived >= state.tamañoArchivoEsperado) {
        window.Cudi.showToast(`✅ File Verified & Received: ${state.nombreArchivoRecibido}`, "success");
        state.bytesReceived = 0; // Reset counter

        if (state.fileWritable) {
            // Close stream
            await state.fileWritable.close();
            state.fileWritable = null;
            // Display "Open" link if possible, or just a success message
            // Note: We cannot create a Blob URL from a closed writable handle easily without re-reading. 
            // But we don't need to. We just show "Saved".
            window.Cudi.displayChatMessage(`Saved to disk: ${state.nombreArchivoRecibido}`, "received", "Sender");
        } else {
            // RAM Fallback
            const ext = state.nombreArchivoRecibido.split('.').pop().toLowerCase();
            let mimeType = state.tipoMimeRecibido || 'application/octet-stream';

            const MIME_MAP = {
                'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
                'mp4': 'video/mp4', 'webm': 'video/webm',
                'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
                'pdf': 'application/pdf'
            };
            if (MIME_MAP[ext]) mimeType = MIME_MAP[ext];

            const blob = new Blob(state.archivoRecibidoBuffers, { type: mimeType });
            state.archivoRecibidoBuffers = []; // Clear RAM

            window.Cudi.displayFileDownload(state.nombreArchivoRecibido, URL.createObjectURL(blob), "received", "Sender", true);
        }
    }
}
