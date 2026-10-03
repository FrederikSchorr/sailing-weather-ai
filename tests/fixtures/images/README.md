# Image fixtures

- `no-metadata.heic`: 368-byte test image from [ExifReader](https://github.com/mattiasw/ExifReader/blob/main/test/fixtures/images/test-no-meta-data.heic), under the repository's [MIT license](https://github.com/mattiasw/ExifReader/blob/main/LICENSE).
- `no-metadata.webp`: locally generated 2×2 solid sky-blue image, with no recording metadata.

GPS fixtures are generated in `../photo-images.ts` with synthetic coordinates. HEIC and WebP retain real decodable image pixels and receive standards-format EXIF metadata; tests do not need external services or personal photos.