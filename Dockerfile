# Ket: one binary with the API, MCP and the embedded UI.
#   docker build -t ket .
#   docker compose -f deploy/compose.yaml up -d

FROM node:24-alpine AS ui
WORKDIR /src/_ui
RUN corepack enable
COPY _ui/package.json _ui/pnpm-lock.yaml _ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY _ui/ ./
# gen-catalog writes ../internal/catalog/catalog.json and vite builds into ../internal/server/dist.
RUN mkdir -p ../internal/catalog ../internal/server/dist && pnpm run build

FROM golang:1.27-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=ui /src/internal/server/dist/ internal/server/dist/
COPY --from=ui /src/internal/catalog/catalog.json internal/catalog/catalog.json
ARG VERSION=v0.0.0
ARG COMMIT=-
ARG BUILD_DATE=-
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/rakunlabs/ket/internal/config.Version=${VERSION} -X github.com/rakunlabs/ket/internal/config.Commit=${COMMIT} -X github.com/rakunlabs/ket/internal/config.BuildDate=${BUILD_DATE}" \
    -o /out/ket ./cmd/ket

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=go /out/ket /ket
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/ket"]
