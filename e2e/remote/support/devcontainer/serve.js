// The dev server the @devcontainer specs' agent starts inside the container; the Ports section forwards its port.
require('node:http').createServer((_request, response) => response.end('dc-port')).listen(Number(process.argv[2]));
