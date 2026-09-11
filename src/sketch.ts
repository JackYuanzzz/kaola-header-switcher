// The package's module entry is bundled/rough.esm.js; its root also exposes exact TypeScript types.
import rough from 'roughjs';

type Surface = { svg: SVGSVGElement; signature: string; seed: number };

/** Sketches decorate native controls without changing their focus or click behavior. */
export function setupSketches(root: HTMLElement): () => void {
    const surfaces = new Map<HTMLElement, Surface>();
    let pendingFrame = 0;
    let nextSeed = 17;
    const observer = new ResizeObserver(() => schedule());

    function paint(element: HTMLElement, surface: Surface): void {
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        if (!width || !height) return;
        const style = element.dataset.sketch || 'box';
        const active = element.classList.contains('active') || element.getAttribute('aria-checked') === 'true';
        const inactive = element.classList.contains('inactive');
        const signature = `${width}:${height}:${style}:${active}:${inactive}`;
        if (surface.signature === signature) return;
        surface.signature = signature;
        const svg = surface.svg;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        const drawing = rough.svg(svg);
        const base = { seed: surface.seed, stroke: '#35332e', strokeWidth: 1.15, roughness: 1.05, bowing: 0.8 };
        const shapes: SVGGElement[] = [];
        const rectangle = (fill?: string, hatch = false, stroke = base.stroke): void => {
            shapes.push(drawing.rectangle(2.5, 2.5, width - 5, height - 5, {
                ...base,
                stroke,
                ...(fill ? { fill, fillStyle: hatch ? 'hachure' : 'solid', fillWeight: 0.8, hachureGap: 6 } : {}),
            }));
        };
        // Long rough.line() strokes become almost ruler-straight. Use short, gently uneven
        // curve sections plus a lighter second pencil pass, stable for this surface's seed.
        const divider = (vertical: boolean, position: number, stroke = base.stroke, weight = 1.15): void => {
            const length = vertical ? height : width;
            const sections = Math.max(3, Math.ceil(length / 65));
            for (let pass = 0; pass < 2; pass += 1) {
                const points: [number, number][] = Array.from({ length: sections + 1 }, (_, index) => {
                    const along = 5 + (length - 10) * index / sections;
                    const drift = Math.sin(surface.seed * 0.47 + index * 1.81 + pass * 0.7) * 1.3
                        + Math.cos(index * 2.3 + pass) * 0.55 + pass * 0.65;
                    return vertical ? [position + drift, along] : [along, position + drift];
                });
                const pencil = drawing.curve(points, {
                    ...base, seed: surface.seed + pass * 31, stroke,
                    strokeWidth: pass ? weight * 0.65 : weight,
                    roughness: 1.65, maxRandomnessOffset: 1.5, curveTightness: 0.15,
                    disableMultiStroke: true,
                });
                if (pass) pencil.setAttribute('opacity', '0.6');
                shapes.push(pencil);
            }
        };
        switch (style) {
            case 'masthead':
            case 'footer':
                divider(false, height - 5);
                break;
            case 'separator':
                divider(false, 4, '#aaa293', 0.95);
                break;
            case 'divider':
                divider(true, width - 5, '#888177');
                break;
            case 'heading':
                shapes.push(drawing.line(2, height - 5, width - 3, height - 5, { ...base, stroke: '#e4a65b', strokeWidth: 5, roughness: 1.4 }));
                divider(false, height - 5, base.stroke, 0.9);
                break;
            case 'rule':
                if (active) rectangle('#bdded4', true, '#426b61');
                else divider(false, height - 5, '#b1aa9e', 0.95);
                break;
            case 'stamp':
                rectangle(inactive ? '#e4ddd0' : '#b9dacd', true, inactive ? '#938c7e' : '#426b61');
                break;
            case 'primary': rectangle('#f3b69b'); break;
            case 'new': rectangle('#f1d690', true); break;
            case 'confirm': rectangle('#e8b193', true, '#9a4936'); break;
            case 'input': rectangle(undefined, false, '#8d8679'); break;
            case 'toggle': {
                const center = active ? width - 12 : 12;
                shapes.push(drawing.rectangle(3, 5, width - 6, height - 10, {
                    ...base, fill: active ? '#9ec9b8' : '#e4dfd3', fillStyle: 'solid', roughness: 0.8,
                }));
                shapes.push(drawing.circle(center, height / 2, 16, {
                    ...base, seed: surface.seed + 1, fill: '#fffdf4', fillStyle: 'solid', roughness: 0.75,
                }));
                break;
            }
            default: rectangle('#fffdf5');
        }
        svg.replaceChildren(...shapes);
    }

    function redraw(): void {
        pendingFrame = 0;
        for (const [element, surface] of surfaces) {
            if (!element.isConnected || !root.contains(element)) {
                observer.unobserve(element);
                surfaces.delete(element);
                surface.svg.remove();
            }
        }
        for (const element of root.querySelectorAll<HTMLElement>('[data-sketch]')) {
            let surface = surfaces.get(element);
            if (!surface || !element.contains(surface.svg)) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.classList.add('sketch-surface');
                svg.setAttribute('aria-hidden', 'true');
                svg.setAttribute('focusable', 'false');
                element.prepend(svg);
                surface = { svg, signature: '', seed: nextSeed++ };
                surfaces.set(element, surface);
                observer.observe(element);
            }
            paint(element, surface);
        }
    }

    function schedule(): void {
        if (!pendingFrame) pendingFrame = requestAnimationFrame(redraw);
    }

    window.addEventListener('pagehide', () => {
        observer.disconnect();
        cancelAnimationFrame(pendingFrame);
        surfaces.clear();
    }, { once: true });
    schedule();
    return schedule;
}
