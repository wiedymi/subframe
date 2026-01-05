#include <ass/ass.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "third_party/stb_image_write.h"

typedef struct {
    int width;
    int height;
    int stride;
    unsigned char *buffer;
} image_t;

static image_t *image_create(int width, int height)
{
    image_t *img = (image_t *) malloc(sizeof(image_t));
    if (!img) return NULL;
    img->width = width;
    img->height = height;
    img->stride = width * 4;
    img->buffer = (unsigned char *) calloc(1, (size_t) height * (size_t) width * 4);
    if (!img->buffer) {
        free(img);
        return NULL;
    }
    return img;
}

static void blend_single(image_t *frame, ASS_Image *img)
{
    unsigned char r = img->color >> 24;
    unsigned char g = (img->color >> 16) & 0xFF;
    unsigned char b = (img->color >> 8) & 0xFF;
    unsigned char a = 255 - (img->color & 0xFF);

    unsigned char *src = img->bitmap;
    unsigned char *dst = frame->buffer + img->dst_y * frame->stride + img->dst_x * 4;

    for (int y = 0; y < img->h; ++y) {
        for (int x = 0; x < img->w; ++x) {
            unsigned k = ((unsigned) src[x]) * a;
            unsigned rounding_offset = 255 * 255 / 2;
            dst[x * 4 + 0] = (k * r + (255 * 255 - k) * dst[x * 4 + 0] + rounding_offset) / (255 * 255);
            dst[x * 4 + 1] = (k * g + (255 * 255 - k) * dst[x * 4 + 1] + rounding_offset) / (255 * 255);
            dst[x * 4 + 2] = (k * b + (255 * 255 - k) * dst[x * 4 + 2] + rounding_offset) / (255 * 255);
            dst[x * 4 + 3] = (k * 255 + (255 * 255 - k) * dst[x * 4 + 3] + rounding_offset) / (255 * 255);
        }
        src += img->stride;
        dst += frame->stride;
    }
}

static void blend(image_t *frame, ASS_Image *img)
{
    while (img) {
        blend_single(frame, img);
        img = img->next;
    }

    // Convert from pre-multiplied to straight alpha
    for (int y = 0; y < frame->height; y++) {
        unsigned char *row = frame->buffer + y * frame->stride;
        for (int x = 0; x < frame->width; x++) {
            const unsigned char alpha = row[4 * x + 3];
            if (alpha) {
                const unsigned int offs = 1u << 15;
                unsigned int inv = ((unsigned int) 255 << 16) / alpha + 1;
                row[x * 4 + 0] = (row[x * 4 + 0] * inv + offs) >> 16;
                row[x * 4 + 1] = (row[x * 4 + 1] * inv + offs) >> 16;
                row[x * 4 + 2] = (row[x * 4 + 2] * inv + offs) >> 16;
            }
        }
    }
}

static void usage(const char *name)
{
    fprintf(stderr, "Usage: %s --ass <file.ass> --time <ms> --w <width> --h <height> [--fonts <dir>] --out <out.png>\n", name);
}

static void rename_duplicate_styles(ASS_Track *track)
{
    if (!track || track->n_styles <= 1) return;

    for (int i = track->n_styles - 2; i >= 0; --i) {
        ASS_Style *style = &track->styles[i];
        if (!style->Name) continue;
        for (int j = i + 1; j < track->n_styles; ++j) {
            ASS_Style *later = &track->styles[j];
            if (!later->Name) continue;
            if (strcmp(style->Name, later->Name) == 0) {
                char buf[256];
                snprintf(buf, sizeof(buf), "%s__libass_builtin_%d", style->Name, i);
                char *dup = strdup(buf);
                if (dup) {
                    free(style->Name);
                    style->Name = dup;
                }
                break;
            }
        }
    }
}

int main(int argc, char **argv)
{
    const char *ass_path = NULL;
    const char *fonts_dir = NULL;
    const char *out_path = NULL;
    int stats = 0;
    int width = 0;
    int height = 0;
    long time_ms = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--ass") == 0 && i + 1 < argc) {
            ass_path = argv[++i];
        } else if (strcmp(argv[i], "--time") == 0 && i + 1 < argc) {
            time_ms = strtol(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--w") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--h") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--fonts") == 0 && i + 1 < argc) {
            fonts_dir = argv[++i];
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--stats") == 0) {
            stats = 1;
        } else {
            usage(argv[0]);
            return 1;
        }
    }

    if (!ass_path || !out_path || width <= 0 || height <= 0) {
        usage(argv[0]);
        return 1;
    }

    ASS_Library *ass_library = ass_library_init();
    if (!ass_library) {
        fprintf(stderr, "libass: failed to init library\n");
        return 1;
    }

    ASS_Renderer *ass_renderer = ass_renderer_init(ass_library);
    if (!ass_renderer) {
        fprintf(stderr, "libass: failed to init renderer\n");
        ass_library_done(ass_library);
        return 1;
    }

    ass_set_storage_size(ass_renderer, width, height);
    ass_set_frame_size(ass_renderer, width, height);
    ass_set_fonts(ass_renderer, fonts_dir, "sans-serif", ASS_FONTPROVIDER_AUTODETECT, NULL, 1);

    ASS_Track *track = ass_read_file(ass_library, ass_path, NULL);
    if (!track) {
        fprintf(stderr, "libass: failed to read ASS file: %s\n", ass_path);
        ass_renderer_done(ass_renderer);
        ass_library_done(ass_library);
        return 1;
    }

    rename_duplicate_styles(track);

    int detect_change = 0;
    ASS_Image *img = ass_render_frame(ass_renderer, track, time_ms, &detect_change);

    image_t *frame = image_create(width, height);
    if (!frame) {
        fprintf(stderr, "libass: failed to allocate frame buffer\n");
        ass_free_track(track);
        ass_renderer_done(ass_renderer);
        ass_library_done(ass_library);
        return 1;
    }

    if (img) blend(frame, img);

    if (stats && img) {
        int min_x = width;
        int min_y = height;
        int max_x = -1;
        int max_y = -1;
        for (ASS_Image *cur = img; cur; cur = cur->next) {
            int x0 = cur->dst_x;
            int y0 = cur->dst_y;
            int x1 = cur->dst_x + cur->w;
            int y1 = cur->dst_y + cur->h;
            if (x0 < min_x) min_x = x0;
            if (y0 < min_y) min_y = y0;
            if (x1 > max_x) max_x = x1;
            if (y1 > max_y) max_y = y1;
        }
        fprintf(stderr, "[ass] track PlayRes: %dx%d\n", track->PlayResX, track->PlayResY);
        for (int i = 0; i < track->n_styles; i++) {
            ASS_Style *st = track->styles + i;
            fprintf(stderr, "[ass] style[%d] Name=%s FontSize=%.2f ScaleX=%.2f ScaleY=%.2f\n",
                    i, st->Name ? st->Name : "(null)", st->FontSize, st->ScaleX, st->ScaleY);
        }
        fprintf(stderr, "[ass] image bbox: (%d,%d)-(%d,%d)\n", min_x, min_y, max_x, max_y);
    }

    if (!stbi_write_png(out_path, width, height, 4, frame->buffer, frame->stride)) {
        fprintf(stderr, "libass: failed to write PNG: %s\n", out_path);
        free(frame->buffer);
        free(frame);
        ass_free_track(track);
        ass_renderer_done(ass_renderer);
        ass_library_done(ass_library);
        return 1;
    }

    free(frame->buffer);
    free(frame);
    ass_free_track(track);
    ass_renderer_done(ass_renderer);
    ass_library_done(ass_library);
    return 0;
}
