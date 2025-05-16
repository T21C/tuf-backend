wget https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-9.0.0-linux-x86_64.tar.gz
wget https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-9.0.0-linux-x86_64.tar.gz.sha512
shasum -a 512 -c elasticsearch-9.0.0-linux-x86_64.tar.gz.sha512
tar -xzf elasticsearch-9.0.0-linux-x86_64.tar.gz --strip-components=1 -C elasticsearch-9.0.0
cd elasticsearch-9.0.0/