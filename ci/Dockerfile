# The release image: the binary GoReleaser built, nothing else. To build an
# image from a checkout without GoReleaser, use the Dockerfile at the root.
FROM gcr.io/distroless/static-debian12:nonroot

# GoReleaser puts each platform's binary under linux/<arch>/ in the context.
ARG TARGETPLATFORM
COPY $TARGETPLATFORM/ket /ket
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/ket"]
