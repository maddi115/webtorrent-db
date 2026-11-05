// images.js - Shrink pictures in the browser before saving or sharing them
export async function resizeImage(source, maxSize, quality = 0.75) {
    const image = new Image();
    const url = source instanceof Blob ? URL.createObjectURL(source) : source;

    try {
        image.src = url;
        await image.decode();

        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));

        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', quality);
    } finally {
        if (source instanceof Blob) URL.revokeObjectURL(url);
    }
}
