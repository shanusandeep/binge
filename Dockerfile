# binge.shanuva.com — static site served by Caddy.
FROM caddy:2-alpine
COPY ops/Caddyfile.internal /etc/caddy/Caddyfile
COPY index.html admin.html /srv/www/
COPY css/ /srv/www/css/
COPY js/ /srv/www/js/
COPY data/ /srv/www/data/
