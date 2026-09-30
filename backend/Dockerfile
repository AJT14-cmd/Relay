FROM eclipse-temurin:25.0.4.1_1-jdk-alpine-3.24 AS build
WORKDIR /build
COPY .mvn .mvn
COPY mvnw pom.xml ./
RUN chmod +x mvnw
COPY src src
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -Dmaven.test.skip=true package

FROM eclipse-temurin:25.0.4.1_1-jre-alpine-3.24
WORKDIR /app
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=build /build/target/Relay-0.0.1-SNAPSHOT.jar /app/relay.jar
USER relay
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1:8080/actuator/health || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/relay.jar"]
