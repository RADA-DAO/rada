# HTTP utilities

Shared streaming body readers for module API routes. Limits count bytes,
including requests without a declared length; JSON decoding starts only after
reading within the limit.
